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

    // Backend sampling target. Real returned point count is controlled by backend stride.
    const MAX_POINTS_QUERY = 80000;

    // Main canvas mount node. Abort early if template is not loaded as expected.
    const container = document.getElementById("threeRoot");
    if (!container) {
        return;
    }

    // Optional HUD fields in the top-right panel (load time / fps).
    const hudLoad = document.getElementById("hudLoad");
    const hudFps = document.getElementById("hudFps");

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
         * fetchTifPayload
         * Function: Fetch sampled terrain payload for the selected project.
         * Key variables: MAX_POINTS_QUERY and project id.
         * Input: resolvedProjectId (string).
         * Output: Promise<{vertices, points, grid, metadata, ...}>.
         */
        async fetchTifPayload(resolvedProjectId) {
            const response = await fetch(
                `/api/projects/${encodeURIComponent(resolvedProjectId)}/tif-points?max_points=${MAX_POINTS_QUERY}`,
            );
            if (!response.ok) {
                throw new Error(`Failed to load point cloud: HTTP ${response.status}`);
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
         * Input: positions Float32Array.
         * Output: THREE.Points.
         */
        createWhitePointCloud(positions) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

            const material = new THREE.PointsMaterial({
                size: 0.8,
                sizeAttenuation: true,
                color: 0xffffff,
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
        createColoredTriangleLines(vertices, centerX, centerY, minZ, zRange) {
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
                const i01 = keyToGeometryIndex.get(`${row}_${col + 1}`);
                const i10 = keyToGeometryIndex.get(`${row + 1}_${col}`);
                const i11 = keyToGeometryIndex.get(`${row + 1}_${col + 1}`);

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
            this.controls.dampingFactor = 0.08;
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
        const payload = await DataModule.fetchTifPayload(projectId);
        DataModule.logPayloadSamples(payload);

        const { points, vertices } = DataModule.normalizePoints(payload);
        if (!points.length) {
            const elapsedMs = performance.now() - loadStartAt;
            RenderModule.setLoadHudText(`${elapsedMs.toFixed(1)} ms (empty)`);
            return;
        }

        const { minZ, zRange, centerX, centerY } = DataModule.computePointStats(points);
        const positions = DataModule.buildCenteredPositions(points, centerX, centerY);

        const cloud = MeshModule.createWhitePointCloud(positions);
        RenderModule.scene.add(cloud);

        const triangleLines = MeshModule.createColoredTriangleLines(vertices, centerX, centerY, minZ, zRange);
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
        window.dispatchEvent(
            new CustomEvent("three-base-ready", {
                detail: window.ThreeOverlayBridge,
            }),
        );

        RenderModule.fitCameraToPoints(positions);
        const elapsedMs = performance.now() - loadStartAt;
        RenderModule.setLoadHudText(`${elapsedMs.toFixed(1)} ms`);
    }

    // Keep UI responsive even if bootstrap fails.
    bootstrap().catch(() => {});
    RenderModule.animate();
})();
