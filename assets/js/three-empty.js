(function () {
    "use strict";

    // Elevation gradient key points (t in [0,1]).
    // Colors are interpolated linearly between adjacent entries.
    // Current palette: deep blue -> deep teal-green -> bright yellow -> light red.
    const ELEVATION_COLOR_GRADIENT = [
        { t: 0.0, color: [18, 42, 120] },
        { t: 0.2, color: [18, 110, 95] },
        { t: 0.7, color: [255, 235, 59] },
        { t: 1.0, color: [245, 130, 130] },
    ];

    const TILE_TARGET_POINTS = 18000;
    const TILE_VISIBLE_UPDATE_DEBOUNCE_MS = 40;
    const TILE_INTERACT_UPDATE_DEBOUNCE_MS = 80;
    const TILE_WHEEL_END_DELAY_MS = 120;
    const TILE_CENTER_MARKER_SIZE = 36;
    const TILE_CENTER_MARKER_Z_OFFSET = 12;
    const TILE_NEIGHBOR_RING = 1;
    const TARGET_VIEW_POINTS = 15000;
    const MAX_DYNAMIC_STRIDE = 32;
    const TILE_FETCH_CONCURRENCY = 4;

    // Main canvas mount node. Abort early if template is not loaded as expected.
    const container = document.getElementById("threeRoot");
    if (!container) {
        return;
    }

    // Optional HUD fields in the top-right panel (load time / fps).
    const perfHud = document.getElementById("perfHud");
    const hudLoad = document.getElementById("hudLoad");
    const hudFps = document.getElementById("hudFps");

    const ensureHudLine = (id, label, defaultText) => {
        const existing = document.getElementById(id);
        if (existing) {
            return existing;
        }
        if (!perfHud) {
            return null;
        }
        const row = document.createElement("div");
        row.innerHTML = `<span class="label">${label}</span><span id="${id}">${defaultText}</span>`;
        perfHud.appendChild(row);
        return document.getElementById(id);
    };

    const hudTileCount = ensureHudLine("hudTileCount", "Tiles", "--");
    const hudTilePoints = ensureHudLine("hudTilePoints", "TilePts", "--");
    const hudVisibleTiles = ensureHudLine("hudVisibleTiles", "Visible", "--");
    const hudLoadedTiles = ensureHudLine("hudLoadedTiles", "Loaded", "--");
    const hudThinFactor = ensureHudLine("hudThinFactor", "Thin", "--");
    const hudThinPoints = ensureHudLine("hudThinPoints", "ThinPts", "--");

    // URL state: /three?project_id=... .
    const params = new URLSearchParams(window.location.search);
    let projectId = params.get("project_id");


    /**
     * DataModule
     * Function: Resolve project id, load TIF payload, and normalize raw data.
     * Key variables: projectId, payload.vertices, payload.points.
     * Flow: resolve id -> fetch payload -> normalize -> compute stats -> build positions.
     */
    const DataModule = {
        /**
         * resolveProjectId
         * Function: Choose active project id from URL or backend fallback.
         * Key variables: currentProjectId, queryParams, `/api/projects/cards` response.
         * Input: currentProjectId (string|null), queryParams (URLSearchParams).
         * Output: Promise<string> resolved id.
         */
        async resolveProjectId(currentProjectId, queryParams) {
            if (currentProjectId) {
                return currentProjectId;
            }

            const response = await fetch("/api/projects/cards", { headers: { Accept: "application/json" } });
            if (!response.ok) {
                throw new Error(`Failed to resolve project id: HTTP ${response.status}`);
            }

            const cards = await response.json();
            if (!Array.isArray(cards) || cards.length === 0) {
                throw new Error("No project found in database.");
            }

            const fallbackProjectId = String(cards[0].id);
            queryParams.set("project_id", fallbackProjectId);
            const nextUrl = `${window.location.pathname}?${queryParams.toString()}`;
            window.history.replaceState({}, "", nextUrl);
            return fallbackProjectId;
        },

        /**
         * fetchTifTilesMeta
         * Function: Fetch square-tile metadata and center points for lazy loading.
         * Input: resolvedProjectId (string).
         * Output: Promise<{tiles, tile_grid, metadata, ...}>.
         */
        async fetchTifTilesMeta(resolvedProjectId) {
            const response = await fetch(
                `/api/projects/${encodeURIComponent(resolvedProjectId)}/tif-tiles?target_points_per_tile=${TILE_TARGET_POINTS}`,
            );
            if (!response.ok) {
                throw new Error(`Failed to load tif tile metadata: HTTP ${response.status}`);
            }
            return response.json();
        },

        /**
         * fetchTifTilePayload
         * Function: Fetch terrain points for one tile window.
         * Input: resolvedProjectId (string), tile (tile metadata record).
         * Output: Promise<{points, vertices, ...}>.
         */
        async fetchTifTilePayload(resolvedProjectId, tile, stride = 1) {
            const query = new URLSearchParams({
                row_start: String(tile.row_start),
                row_end: String(tile.row_end),
                col_start: String(tile.col_start),
                col_end: String(tile.col_end),
                stride: String(Math.max(1, Math.min(MAX_DYNAMIC_STRIDE, Math.trunc(stride) || 1))),
            });
            const response = await fetch(
                `/api/projects/${encodeURIComponent(resolvedProjectId)}/tif-tile-points?${query.toString()}`,
            );
            if (!response.ok) {
                throw new Error(`Failed to load tif tile points: HTTP ${response.status}`);
            }
            return response.json();
        },

        /**
         * logPayloadSamples
         * Function: Print compact payload diagnostics.
         * Input: payload object.
         * Output: none (side effect: console log).
         */
        logPayloadSamples(payload) {
            const vertices = Array.isArray(payload.vertices) ? payload.vertices : [];
            const pointsFromPayload = Array.isArray(payload.points) ? payload.points : [];

            console.log("[tif-points] summary", {
                project_id: payload.project_id,
                point_count: payload.point_count,
                stride: payload.stride,
                grid: payload.grid,
                metadata: payload.metadata,
            });
            console.log("[tif-points] vertices sample", vertices.slice(0, 5));
            console.log("[tif-points] points sample", pointsFromPayload.slice(0, 5));
        },

        logTileMetaSummary(payload) {
            const tiles = Array.isArray(payload.tiles) ? payload.tiles : [];
            console.log("[tif-tiles] summary", {
                project_id: payload.project_id,
                tile_count: payload.tile_count,
                tile_grid: payload.tile_grid,
                valid_point_count: payload.valid_point_count,
                target_points_per_tile: payload.target_points_per_tile,
                metadata: payload.metadata,
                first_tiles: tiles.slice(0, 5),
            });
        },

        /**
         * normalizePoints
         * Function: Produce a clean `[x,y,z]` list plus raw vertices for mesh reconstruction.
         * Key variables: valid flag, finite numeric checks.
         * Flow: prefer valid vertices; fallback to flat points array when needed.
         * Input: payload object.
         * Output: { points: number[][], vertices: object[] }.
         */
        normalizePoints(payload) {
            const vertices = Array.isArray(payload.vertices) ? payload.vertices : [];
            const pointsFromPayload = Array.isArray(payload.points) ? payload.points : [];
            const points = [];

            if (vertices.length) {
                for (let i = 0; i < vertices.length; i += 1) {
                    const vertex = vertices[i];
                    if (!vertex || !vertex.valid) {
                        continue;
                    }

                    const x = Number(vertex.x);
                    const y = Number(vertex.y);
                    const z = Number(vertex.elevation);
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                        continue;
                    }
                    points.push([x, y, z]);
                }
            }

            if (!points.length) {
                for (let i = 0; i < pointsFromPayload.length; i += 1) {
                    const point = pointsFromPayload[i];
                    const x = Number(point[0]);
                    const y = Number(point[1]);
                    const z = Number(point[2]);
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                        continue;
                    }
                    points.push([x, y, z]);
                }
            }

            return { points, vertices };
        },

        /**
         * computePointStats
         * Function: Compute min/max/range and XY center for terrain points.
         * Key variables: minZ, maxZ, zRange, centerX, centerY.
         * Input: points ([[x,y,z],...]).
         * Output: { minZ, maxZ, zRange, centerX, centerY }.
         */
        computePointStats(points) {
            let minZ = Number.POSITIVE_INFINITY;
            let maxZ = Number.NEGATIVE_INFINITY;
            let sumX = 0;
            let sumY = 0;

            for (let i = 0; i < points.length; i += 1) {
                const x = Number(points[i][0]);
                const y = Number(points[i][1]);
                const z = Number(points[i][2]);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                    continue;
                }

                minZ = Math.min(minZ, z);
                maxZ = Math.max(maxZ, z);
                sumX += x;
                sumY += y;
            }

            if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
                minZ = 0;
                maxZ = 1;
            }

            const zRange = Math.max(maxZ - minZ, 1e-9);
            const centerX = sumX / points.length;
            const centerY = sumY / points.length;

            return { minZ, maxZ, zRange, centerX, centerY };
        },

        /**
         * buildCenteredPositions
         * Function: Convert point list into packed Float32Array position buffer.
         * Note: XY remains in world coordinates; no centering transform is applied.
         * Input: points ([[x,y,z],...]), centerX/centerY (reserved compatibility args).
         * Output: Float32Array positions.
         */
        buildCenteredPositions(points, centerX, centerY) {
            const positions = new Float32Array(points.length * 3);
            for (let i = 0; i < points.length; i += 1) {
                const x = Number(points[i][0]);
                const y = Number(points[i][1]);
                const z = Number(points[i][2]);

                positions[i * 3] = x;
                positions[i * 3 + 1] = y;
                positions[i * 3 + 2] = z;
            }
            return positions;
        },
    };

    /**
     * MeshModule
     * Function: Build renderable terrain primitives and elevation colors.
     * Key variables: elevation gradient, vertex/index reconstruction maps.
     */
    const MeshModule = {
        /**
         * sampleElevationRamp
         * Function: Convert normalized elevation ratio to RGB.
         * Input: t in [0,1].
         * Output: [r,g,b] in [0,1].
         */
        sampleElevationRamp(t) {
            if (t <= ELEVATION_COLOR_GRADIENT[0].t) {
                return ELEVATION_COLOR_GRADIENT[0].color.map((value) => value / 255);
            }

            for (let i = 0; i < ELEVATION_COLOR_GRADIENT.length - 1; i += 1) {
                const left = ELEVATION_COLOR_GRADIENT[i];
                const right = ELEVATION_COLOR_GRADIENT[i + 1];
                if (t >= left.t && t <= right.t) {
                    const localT = (t - left.t) / Math.max(right.t - left.t, 1e-9);
                    return [
                        (left.color[0] + (right.color[0] - left.color[0]) * localT) / 255,
                        (left.color[1] + (right.color[1] - left.color[1]) * localT) / 255,
                        (left.color[2] + (right.color[2] - left.color[2]) * localT) / 255,
                    ];
                }
            }

            return ELEVATION_COLOR_GRADIENT[ELEVATION_COLOR_GRADIENT.length - 1].color.map((value) => value / 255);
        },

        /**
         * createWhitePointCloud
         * Function: Build base terrain point-cloud object.
         * Input: positions Float32Array, optional colors Float32Array.
         * Output: THREE.Points.
         */
        createWhitePointCloud(positions, colors = null) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
            if (colors && colors.length === positions.length) {
                geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
            }

            const material = new THREE.PointsMaterial({
                size: 0.8,
                sizeAttenuation: true,
                color: 0xffffff,
                vertexColors: Boolean(colors),
                opacity: 0.6,
                transparent: true,
            });

            return new THREE.Points(geometry, material);
        },

        /**
         * createColoredTriangleLines
         * Function: Rebuild wireframe-like triangle edges from grid-aware sampled vertices.
         * Key variables: keyToGeometryIndex map, triangleIndices, edgeSet.
         * Flow:
         * 1) map valid sampled vertices to local geometry indices
         * 2) reconstruct quad triangles from row/col neighbors
         * 3) deduplicate shared edges
         * 4) emit colored line segments
         * Input: vertices, centerX/centerY (reserved), minZ, zRange.
         * Output: THREE.LineSegments or null.
         */
        createColoredTriangleLines(vertices, centerX, centerY, minZ, zRange, sampleStep = 1) {
            if (!Array.isArray(vertices) || !vertices.length) {
                return null;
            }

            const keyToGeometryIndex = new Map();
            const geometryPositions = [];
            const geometryVertexColors = [];

            const getColorForZ = (zValue) => {
                const t = THREE.MathUtils.clamp((zValue - minZ) / Math.max(zRange, 1e-9), 0, 1);
                return MeshModule.sampleElevationRamp(t);
            };

            for (let i = 0; i < vertices.length; i += 1) {
                const vertex = vertices[i];
                if (!vertex || !vertex.valid) {
                    continue;
                }

                const sampleRow = Number(vertex.sample_row);
                const sampleCol = Number(vertex.sample_col);
                const x = Number(vertex.x);
                const y = Number(vertex.y);
                const z = Number(vertex.elevation);
                if (!Number.isFinite(sampleRow) || !Number.isFinite(sampleCol) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                    continue;
                }

                const key = `${sampleRow}_${sampleCol}`;
                keyToGeometryIndex.set(key, geometryPositions.length / 3);
                geometryPositions.push(x, y, z);

                const [r, g, b] = getColorForZ(z);
                geometryVertexColors.push(r, g, b);
            }

            const rowStep = Math.max(1, Math.trunc(sampleStep) || 1);
            const colStep = rowStep;
            if (!Number.isFinite(rowStep) || !Number.isFinite(colStep)) {
                return null;
            }

            const triangleIndices = [];
            for (const key of keyToGeometryIndex.keys()) {
                const parts = key.split("_");
                if (parts.length !== 2) {
                    continue;
                }

                const row = Number(parts[0]);
                const col = Number(parts[1]);
                if (!Number.isFinite(row) || !Number.isFinite(col)) {
                    continue;
                }

                const i00 = keyToGeometryIndex.get(`${row}_${col}`);
                const i01 = keyToGeometryIndex.get(`${row}_${col + colStep}`);
                const i10 = keyToGeometryIndex.get(`${row + rowStep}_${col}`);
                const i11 = keyToGeometryIndex.get(`${row + rowStep}_${col + colStep}`);

                if (i00 == null || i01 == null || i10 == null || i11 == null) {
                    continue;
                }

                triangleIndices.push(i00, i01, i11);
                triangleIndices.push(i00, i11, i10);
            }

            if (!triangleIndices.length || !geometryPositions.length) {
                return null;
            }

            const edgePositionArray = [];
            const edgeColorArray = [];
            const edgeSet = new Set();

            const appendEdge = (idxA, idxB) => {
                const edgeKey = idxA < idxB ? `${idxA}_${idxB}` : `${idxB}_${idxA}`;
                if (edgeSet.has(edgeKey)) {
                    return;
                }
                edgeSet.add(edgeKey);

                const baseA = idxA * 3;
                const baseB = idxB * 3;

                edgePositionArray.push(
                    geometryPositions[baseA], geometryPositions[baseA + 1], geometryPositions[baseA + 2],
                    geometryPositions[baseB], geometryPositions[baseB + 1], geometryPositions[baseB + 2],
                );

                edgeColorArray.push(
                    geometryVertexColors[baseA], geometryVertexColors[baseA + 1], geometryVertexColors[baseA + 2],
                    geometryVertexColors[baseB], geometryVertexColors[baseB + 1], geometryVertexColors[baseB + 2],
                );
            };

            for (let i = 0; i < triangleIndices.length; i += 3) {
                const a = triangleIndices[i];
                const b = triangleIndices[i + 1];
                const c = triangleIndices[i + 2];

                appendEdge(a, b);
                appendEdge(b, c);
                appendEdge(c, a);
            }

            if (!edgePositionArray.length) {
                return null;
            }

            const lineGeometry = new THREE.BufferGeometry();
            lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePositionArray, 3));
            lineGeometry.setAttribute("color", new THREE.Float32BufferAttribute(edgeColorArray, 3));

            const lineMaterial = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.42,
            });

            return new THREE.LineSegments(lineGeometry, lineMaterial);
        },
    };

    /**
     * RenderModule
     * Function: Own three.js scene lifecycle, camera fitting, and animation loop.
     * Key variables: scene/camera/renderer/controls and FPS counters.
     */
    const RenderModule = {
        scene: null,
        camera: null,
        renderer: null,
        controls: null,

        lastFrameAt: performance.now(),
        fpsElapsedMs: 0,
        fpsFrameCount: 0,

        /**
         * init
         * Function: Create scene, camera, renderer, controls, lights, and resize behavior.
         * Input/Output: none.
         */
        init() {
            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(0x05070d);

            this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
            this.camera.position.set(0, 20, 60);

            this.renderer = new THREE.WebGLRenderer({ antialias: true });
            this.renderer.setPixelRatio(window.devicePixelRatio || 1);
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            container.appendChild(this.renderer.domElement);

            this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.controls.enableDamping = true;
            this.controls.dampingFactor = 0.2;
            this.controls.screenSpacePanning = true;

            this.scene.add(new THREE.AxesHelper(10));

            this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
            const dir = new THREE.DirectionalLight(0xffffff, 0.35);
            dir.position.set(30, 60, 20);
            this.scene.add(dir);

            window.addEventListener("resize", () => {
                this.camera.aspect = window.innerWidth / window.innerHeight;
                this.camera.updateProjectionMatrix();
                this.renderer.setSize(window.innerWidth, window.innerHeight);
            });
        },

        /**
         * fitCameraToPoints
         * Function: Fit camera and clipping planes to geometry bounds.
         * Key variables: bounding box center/size and derived maxDim.
         * Input: positions Float32Array.
         * Output: none.
         */
        fitCameraToPoints(positions) {
            const box = new THREE.Box3();
            const temp = new THREE.Vector3();

            for (let i = 0; i < positions.length; i += 3) {
                temp.set(positions[i], positions[i + 1], positions[i + 2]);
                box.expandByPoint(temp);
            }

            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z, 1);
            const distance = maxDim * 1.5;

            this.camera.near = Math.max(0.1, maxDim / 10000);
            this.camera.far = maxDim * 120;
            this.camera.position.set(center.x, center.y - distance, center.z + distance * 0.75);
            this.camera.lookAt(center);
            this.camera.updateProjectionMatrix();

            this.controls.target.copy(center);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        },

        /**
         * setLoadHudText
         * Function: Write load time/status text to HUD when present.
         * Input: text string.
         * Output: none.
         */
        setLoadHudText(text) {
            if (hudLoad) {
                hudLoad.textContent = text;
            }
        },

        /**
         * animate
         * Function: Main RAF loop for controls, rendering, and FPS HUD updates.
         * Input/Output: none.
         */
        animate() {
            requestAnimationFrame(() => this.animate());

            const now = performance.now();
            const deltaMs = now - this.lastFrameAt;
            this.lastFrameAt = now;

            this.fpsElapsedMs += deltaMs;
            this.fpsFrameCount += 1;

            if (this.fpsElapsedMs >= 500) {
                const fps = (this.fpsFrameCount * 1000) / Math.max(this.fpsElapsedMs, 1);
                if (hudFps) {
                    hudFps.textContent = fps.toFixed(1);
                }
                this.fpsElapsedMs = 0;
                this.fpsFrameCount = 0;
            }

            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        },
    };

    /**
     * bootstrap
     * Function: App entry for base terrain scene.
     * Flow:
     * 1) initialize renderer/scene
     * 2) resolve project id
     * 3) fetch and normalize TIF payload
     * 4) add points and wireframe lines
     * 5) publish ThreeOverlayBridge and fit camera
     * Input: none.
     * Output: Promise<void>.
     */
    async function bootstrap() {
        const loadStartAt = performance.now();
        RenderModule.init();

        window.ThreeOverlayBridge = {
            scene: RenderModule.scene,
            camera: RenderModule.camera,
            renderer: RenderModule.renderer,
            controls: RenderModule.controls,
            ready: false,
            centerX: 0,
            centerY: 0,
            minZ: 0,
            maxZ: 1,
            zRange: 1,
        };

        projectId = await DataModule.resolveProjectId(projectId, params);
        const tileMeta = await DataModule.fetchTifTilesMeta(projectId);
        DataModule.logTileMetaSummary(tileMeta);

        const tiles = Array.isArray(tileMeta.tiles) ? tileMeta.tiles : [];
        if (!tiles.length) {
            const elapsedMs = performance.now() - loadStartAt;
            RenderModule.setLoadHudText(`${elapsedMs.toFixed(1)} ms (empty)`);
            return;
        }

        const meta = tileMeta.metadata || {};
        const zMid = Number(meta.z_mid);
        const bboxMinX = Number(meta.bbox_minx);
        const bboxMinY = Number(meta.bbox_miny);
        const bboxMaxX = Number(meta.bbox_maxx);
        const bboxMaxY = Number(meta.bbox_maxy);

        if (
            Number.isFinite(zMid)
            && Number.isFinite(bboxMinX)
            && Number.isFinite(bboxMinY)
            && Number.isFinite(bboxMaxX)
            && Number.isFinite(bboxMaxY)
        ) {
            const fitPositions = new Float32Array([
                bboxMinX, bboxMinY, zMid,
                bboxMinX, bboxMaxY, zMid,
                bboxMaxX, bboxMinY, zMid,
                bboxMaxX, bboxMaxY, zMid,
            ]);
            RenderModule.fitCameraToPoints(fitPositions);
        }

        const tileCache = new Map();
        const tileMarkerMap = new Map();
        let tileMarkerGroup = null;
        let cloud = null;
        let triangleLines = null;
        let firstRenderable = true;
        let refreshSeq = 0;
        let refreshTimer = null;
        let scheduledNeedsRebuild = false;
        let refreshInFlight = false;
        let refreshQueued = false;
        let refreshQueuedNeedsRebuild = false;
        let controlsInteracting = false;
        let lastInteractionType = "unknown";

        const tileKey = (tile) => `${tile.row_start}:${tile.row_end}:${tile.col_start}:${tile.col_end}`;
        const tileRcKey = (tileRow, tileCol) => `${tileRow}:${tileCol}`;
        const tileGridRows = Number(tileMeta.tile_grid?.rows) || 0;
        const tileGridCols = Number(tileMeta.tile_grid?.cols) || 0;
        const tileByRc = new Map();
        for (let i = 0; i < tiles.length; i += 1) {
            const tile = tiles[i];
            tileByRc.set(tileRcKey(Number(tile.tile_row), Number(tile.tile_col)), tile);
        }

        const expandTilesWithNeighborRing = (seedTiles) => {
            if (!Array.isArray(seedTiles) || seedTiles.length === 0) {
                return [];
            }
            const expanded = [];
            const seen = new Set();

            for (let i = 0; i < seedTiles.length; i += 1) {
                const seed = seedTiles[i];
                const seedRow = Number(seed.tile_row);
                const seedCol = Number(seed.tile_col);
                if (!Number.isFinite(seedRow) || !Number.isFinite(seedCol)) {
                    continue;
                }

                for (let dr = -TILE_NEIGHBOR_RING; dr <= TILE_NEIGHBOR_RING; dr += 1) {
                    for (let dc = -TILE_NEIGHBOR_RING; dc <= TILE_NEIGHBOR_RING; dc += 1) {
                        const nr = seedRow + dr;
                        const nc = seedCol + dc;
                        if (nr < 0 || nr >= tileGridRows || nc < 0 || nc >= tileGridCols) {
                            continue;
                        }
                        const neighbor = tileByRc.get(tileRcKey(nr, nc));
                        if (!neighbor) {
                            continue;
                        }
                        const key = tileKey(neighbor);
                        if (seen.has(key)) {
                            continue;
                        }
                        seen.add(key);
                        expanded.push(neighbor);
                    }
                }
            }

            return expanded;
        };

        const formatTileList = (tileList, maxLen = 12) => {
            if (!Array.isArray(tileList) || tileList.length === 0) {
                return "none";
            }
            const values = tileList
                .slice(0, maxLen)
                .map((tile) => `r${tile.tile_row}c${tile.tile_col}`);
            if (tileList.length > maxLen) {
                values.push(`+${tileList.length - maxLen}`);
            }
            return values.join(",");
        };

        const updateTileHud = (visibleTiles, dynamicStride, renderedPointCount, visiblePointEstimate) => {
            const tileCount = Number(tileMeta.tile_count) || tiles.length;
            const validTotal = Number(tileMeta.valid_point_count) || 0;
            const targetPerTile = Number(tileMeta.target_points_per_tile) || TILE_TARGET_POINTS;
            const approxPerTile = tileCount > 0 ? Math.round(validTotal / tileCount) : 0;
            const loadedTiles = tiles.filter((tile) => tileCache.has(tileKey(tile)));

            if (hudTileCount) {
                hudTileCount.textContent = `${tileCount} (${tileMeta.tile_grid?.rows || 0}x${tileMeta.tile_grid?.cols || 0})`;
            }
            if (hudTilePoints) {
                hudTilePoints.textContent = `target ${targetPerTile}, avg ${approxPerTile}`;
            }
            if (hudVisibleTiles) {
                hudVisibleTiles.textContent = `${visibleTiles.length}: ${formatTileList(visibleTiles)}`;
            }
            if (hudLoadedTiles) {
                hudLoadedTiles.textContent = `${loadedTiles.length}: ${formatTileList(loadedTiles)}`;
            }
            if (hudThinFactor) {
                hudThinFactor.textContent = `i=${dynamicStride} (raw ${visiblePointEstimate})`;
            }
            if (hudThinPoints) {
                hudThinPoints.textContent = String(renderedPointCount);
            }
        };

        const updateTileMarkerStates = (visibleTiles) => {
            const visibleKeys = new Set(visibleTiles.map((tile) => tileKey(tile)));
            for (let i = 0; i < tiles.length; i += 1) {
                const tile = tiles[i];
                const key = tileKey(tile);
                const marker = tileMarkerMap.get(key);
                if (!marker) {
                    continue;
                }
                const isVisible = visibleKeys.has(key);
                const isLoaded = tileCache.has(key);
                const lineColor = isVisible ? 0xffd84d : (isLoaded ? 0xff4fd8 : 0x31c7f6);
                const dotColor = isVisible ? 0xffa300 : (isLoaded ? 0xff00d9 : 0x00d4ff);
                marker.line.material.color.setHex(lineColor);
                marker.dot.material.color.setHex(dotColor);
                marker.dot.material.opacity = isVisible ? 1.0 : (isLoaded ? 0.9 : 0.55);
            }
        };

        const createTileCenterMarkers = () => {
            if (tileMarkerGroup) {
                RenderModule.scene.remove(tileMarkerGroup);
                tileMarkerMap.clear();
            }
            tileMarkerGroup = new THREE.Group();
            tileMarkerGroup.name = "tifTileCenters";

            const markerZ = (Number.isFinite(zMid) ? zMid : 0) + TILE_CENTER_MARKER_Z_OFFSET;
            for (let i = 0; i < tiles.length; i += 1) {
                const tile = tiles[i];
                const cx = Number(tile.center_x);
                const cy = Number(tile.center_y);
                if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
                    continue;
                }

                const crossGeometry = new THREE.BufferGeometry();
                const half = TILE_CENTER_MARKER_SIZE * 0.5;
                const crossPositions = new Float32Array([
                    cx - half, cy, markerZ,
                    cx + half, cy, markerZ,
                    cx, cy - half, markerZ,
                    cx, cy + half, markerZ,
                ]);
                crossGeometry.setAttribute("position", new THREE.BufferAttribute(crossPositions, 3));
                const crossMaterial = new THREE.LineBasicMaterial({
                    color: 0x31c7f6,
                    transparent: true,
                    opacity: 0.9,
                    depthTest: false,
                });
                const cross = new THREE.LineSegments(crossGeometry, crossMaterial);
                cross.renderOrder = 1200;

                const dot = new THREE.Mesh(
                    new THREE.SphereGeometry(Math.max(2, TILE_CENTER_MARKER_SIZE * 0.08), 10, 10),
                    new THREE.MeshBasicMaterial({
                        color: 0x00d4ff,
                        transparent: true,
                        opacity: 0.6,
                        depthTest: false,
                    }),
                );
                dot.position.set(cx, cy, markerZ + 0.5);
                dot.renderOrder = 1201;

                tileMarkerGroup.add(cross);
                tileMarkerGroup.add(dot);
                tileMarkerMap.set(tileKey(tile), { line: cross, dot });
            }

            RenderModule.scene.add(tileMarkerGroup);
        };

        const createFrustum = () => {
            RenderModule.camera.updateMatrixWorld();
            const matrix = new THREE.Matrix4().multiplyMatrices(
                RenderModule.camera.projectionMatrix,
                RenderModule.camera.matrixWorldInverse,
            );
            const frustum = new THREE.Frustum();
            frustum.setFromProjectionMatrix(matrix);
            return frustum;
        };

        const collectVisibleTiles = () => {
            const frustum = createFrustum();
            const centerZ = Number.isFinite(zMid) ? zMid : 0;
            const visibleSeeds = [];
            const target = RenderModule.controls.target;

            for (let i = 0; i < tiles.length; i += 1) {
                const tile = tiles[i];
                const cx = Number(tile.center_x);
                const cy = Number(tile.center_y);
                if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
                    continue;
                }
                if (frustum.containsPoint(new THREE.Vector3(cx, cy, centerZ))) {
                    const dx = cx - target.x;
                    const dy = cy - target.y;
                    visibleSeeds.push({ tile, dist2: dx * dx + dy * dy });
                }
            }

            if (visibleSeeds.length > 0) {
                visibleSeeds.sort((a, b) => a.dist2 - b.dist2);
                const seedTiles = visibleSeeds.map((entry) => entry.tile);
                return {
                    seedTiles,
                    renderTiles: expandTilesWithNeighborRing(seedTiles),
                };
            }

            // Fallback: when no center is inside current frustum, load the nearest tile.
            let nearest = null;
            let nearestDist = Number.POSITIVE_INFINITY;
            for (let i = 0; i < tiles.length; i += 1) {
                const tile = tiles[i];
                const cx = Number(tile.center_x);
                const cy = Number(tile.center_y);
                if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
                    continue;
                }
                const dx = cx - target.x;
                const dy = cy - target.y;
                const dist = dx * dx + dy * dy;
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = tile;
                }
            }
            if (!nearest) {
                return { seedTiles: [], renderTiles: [] };
            }

            return {
                seedTiles: [nearest],
                renderTiles: expandTilesWithNeighborRing([nearest]),
            };
        };

        const rebuildSceneFromVisibleTiles = (visibleTiles, sampleStep) => {
            const uniqueVertexByKey = new Map();

            for (let i = 0; i < visibleTiles.length; i += 1) {
                const cached = tileCache.get(tileKey(visibleTiles[i]));
                if (!cached) {
                    continue;
                }
                const payloadVertices = Array.isArray(cached.vertices) ? cached.vertices : [];
                for (let v = 0; v < payloadVertices.length; v += 1) {
                    const vertex = payloadVertices[v];
                    if (!vertex || !vertex.valid) {
                        continue;
                    }
                    const row = Number(vertex.sample_row);
                    const col = Number(vertex.sample_col);
                    const x = Number(vertex.x);
                    const y = Number(vertex.y);
                    const z = Number(vertex.elevation);
                    if (!Number.isFinite(row) || !Number.isFinite(col) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                        continue;
                    }
                    const key = `${row}_${col}`;
                    if (!uniqueVertexByKey.has(key)) {
                        uniqueVertexByKey.set(key, vertex);
                    }
                }
            }

            const mergedVertices = Array.from(uniqueVertexByKey.values());
            const mergedPoints = mergedVertices.map((vertex) => [Number(vertex.x), Number(vertex.y), Number(vertex.elevation)]);

            if (!mergedPoints.length) {
                return 0;
            }

            const { minZ, zRange, centerX, centerY } = DataModule.computePointStats(mergedPoints);
            const positions = DataModule.buildCenteredPositions(mergedPoints, centerX, centerY);
            const colors = new Float32Array(mergedPoints.length * 3);
            for (let i = 0; i < mergedPoints.length; i += 1) {
                const z = Number(mergedPoints[i][2]);
                const t = THREE.MathUtils.clamp((z - minZ) / Math.max(zRange, 1e-9), 0, 1);
                const [r, g, b] = MeshModule.sampleElevationRamp(t);
                colors[i * 3] = r;
                colors[i * 3 + 1] = g;
                colors[i * 3 + 2] = b;
            }

            if (cloud) {
                cloud.geometry.dispose();
                cloud.material.dispose();
                RenderModule.scene.remove(cloud);
                cloud = null;
            }
            cloud = MeshModule.createWhitePointCloud(positions, colors);
            RenderModule.scene.add(cloud);

            if (triangleLines) {
                triangleLines.geometry.dispose();
                triangleLines.material.dispose();
                RenderModule.scene.remove(triangleLines);
                triangleLines = null;
            }

            triangleLines = MeshModule.createColoredTriangleLines(mergedVertices, centerX, centerY, minZ, zRange, sampleStep);
            if (triangleLines) {
                RenderModule.scene.add(triangleLines);
            }

            window.ThreeOverlayBridge = {
                scene: RenderModule.scene,
                camera: RenderModule.camera,
                renderer: RenderModule.renderer,
                controls: RenderModule.controls,
                ready: true,
                centerX: 0,
                centerY: 0,
                minZ,
                maxZ: minZ + zRange,
                zRange,
            };

            if (firstRenderable) {
                window.dispatchEvent(
                    new CustomEvent("three-base-ready", {
                        detail: window.ThreeOverlayBridge,
                    }),
                );
                firstRenderable = false;
            }

            const elapsedMs = performance.now() - loadStartAt;
            RenderModule.setLoadHudText(`${elapsedMs.toFixed(1)} ms | tiles ${visibleTiles.length}`);
            return mergedPoints.length;
        };

        const runWithConcurrency = async (taskFactories, limit) => {
            const safeLimit = Math.max(1, Math.trunc(limit) || 1);
            let cursor = 0;

            const worker = async () => {
                while (cursor < taskFactories.length) {
                    const index = cursor;
                    cursor += 1;
                    await taskFactories[index]();
                }
            };

            const workers = [];
            for (let i = 0; i < Math.min(safeLimit, taskFactories.length); i += 1) {
                workers.push(worker());
            }
            await Promise.all(workers);
        };

        const updateVisibleTiles = async (options = {}) => {
            const skipRebuild = Boolean(options.skipRebuild);
            const requestId = refreshSeq + 1;
            refreshSeq = requestId;

            const { seedTiles, renderTiles } = collectVisibleTiles();
            const visibleTiles = renderTiles;
            const visiblePointEstimate = seedTiles.reduce((acc, tile) => acc + (Number(tile.point_count) || 0), 0);
            const dynamicStride = Math.max(
                1,
                Math.min(MAX_DYNAMIC_STRIDE, Math.ceil(Math.max(visiblePointEstimate, 1) / TARGET_VIEW_POINTS)),
            );
            const taskFactories = [];
            for (let i = 0; i < visibleTiles.length; i += 1) {
                const tile = visibleTiles[i];
                const key = tileKey(tile);
                const cached = tileCache.get(key);
                if (cached && Number(cached._stride || 1) === dynamicStride) {
                    continue;
                }
                taskFactories.push(async () => {
                    const payload = await DataModule.fetchTifTilePayload(projectId, tile, dynamicStride);
                        payload._stride = dynamicStride;
                        tileCache.set(key, payload);
                });
            }

            if (taskFactories.length) {
                await runWithConcurrency(taskFactories, TILE_FETCH_CONCURRENCY);
            }

            if (requestId !== refreshSeq) {
                return;
            }

            let renderedPointCount = 0;
            if (skipRebuild) {
                for (let i = 0; i < visibleTiles.length; i += 1) {
                    const cached = tileCache.get(tileKey(visibleTiles[i]));
                    if (!cached || !Array.isArray(cached.points)) {
                        continue;
                    }
                    renderedPointCount += cached.points.length;
                }
            } else {
                renderedPointCount = rebuildSceneFromVisibleTiles(visibleTiles, dynamicStride);
            }
            updateTileMarkerStates(visibleTiles);
            updateTileHud(visibleTiles, dynamicStride, renderedPointCount, visiblePointEstimate);
        };

        const queueVisibleRefresh = (options = {}) => {
            const skipRebuild = Boolean(options.skipRebuild);
            refreshQueued = true;
            if (!skipRebuild) {
                refreshQueuedNeedsRebuild = true;
            }

            if (refreshInFlight) {
                return;
            }

            const drain = async () => {
                refreshInFlight = true;
                try {
                    while (refreshQueued) {
                        const runSkipRebuild = !refreshQueuedNeedsRebuild;
                        refreshQueued = false;
                        refreshQueuedNeedsRebuild = false;
                        await updateVisibleTiles({ skipRebuild: runSkipRebuild });
                    }
                } finally {
                    refreshInFlight = false;
                    if (refreshQueued) {
                        void drain();
                    }
                }
            };

            void drain();
        };

        createTileCenterMarkers();

        await updateVisibleTiles();

        const scheduleRefresh = (delayMs, options = {}) => {
            const skipRebuild = Boolean(options.skipRebuild);
            if (!skipRebuild) {
                scheduledNeedsRebuild = true;
            }
            if (refreshTimer) {
                window.clearTimeout(refreshTimer);
            }
            refreshTimer = window.setTimeout(() => {
                refreshTimer = null;
                const runSkipRebuild = !scheduledNeedsRebuild;
                scheduledNeedsRebuild = false;
                queueVisibleRefresh({ skipRebuild: runSkipRebuild });
            }, delayMs);
        };

        RenderModule.renderer.domElement.addEventListener("wheel", () => {
            lastInteractionType = "wheel";
        }, { passive: true });

        RenderModule.renderer.domElement.addEventListener("pointerdown", (event) => {
            if (event.button === 0) {
                lastInteractionType = "rotate";
            } else if (event.button === 2) {
                lastInteractionType = "pan";
            } else {
                lastInteractionType = "pointer";
            }
        });

        RenderModule.controls.addEventListener("start", () => {
            controlsInteracting = true;
            if (refreshTimer) {
                window.clearTimeout(refreshTimer);
                refreshTimer = null;
            }
        });

        RenderModule.controls.addEventListener("change", () => {
            // Avoid heavy refresh storm while user is actively dragging/zooming.
            if (controlsInteracting) {
                scheduleRefresh(TILE_INTERACT_UPDATE_DEBOUNCE_MS, { skipRebuild: true });
                return;
            }
            scheduleRefresh(TILE_VISIBLE_UPDATE_DEBOUNCE_MS);
        });

        RenderModule.controls.addEventListener("end", () => {
            controlsInteracting = false;
            if (lastInteractionType === "wheel") {
                // Wheel emits dense events; delay refresh slightly to avoid per-notch stalls.
                scheduleRefresh(TILE_WHEEL_END_DELAY_MS);
                lastInteractionType = "unknown";
                return;
            }
            lastInteractionType = "unknown";
            queueVisibleRefresh();
        });
    }

    // Keep UI responsive even if bootstrap fails.
    bootstrap().catch(() => {});
    RenderModule.animate();
})();
