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


    // Module 1: data processing and payload normalization.
    const DataModule = {
        // Use URL project_id first; fallback to the first card from database.
        // Fallback id is written back into URL so refresh/share keeps the same project.
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

        // Fetch raster-derived payload for rendering.
        // API returns both:
        // 1) vertices: grid-aware records (row/col + valid flag)
        // 2) points: flat valid [x,y,z] list for simple point rendering
        async fetchTifPayload(resolvedProjectId) {
            // HOT PATH (I/O + parsing): this request can return very large JSON payloads.
            // The cost here is mostly network transfer + JSON parse, not local branch logic.
            const response = await fetch(
                `/api/projects/${encodeURIComponent(resolvedProjectId)}/tif-points?max_points=${MAX_POINTS_QUERY}`,
            );
            if (!response.ok) {
                throw new Error(`Failed to load point cloud: HTTP ${response.status}`);
            }
            // HOT PATH: response.json() allocates and parses the entire payload in one shot.
            return response.json();
        },

        // Debug helper: print compact payload summary and small samples.
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

        // Normalize payload into a clean point list and keep vertices for mesh reconstruction.
        // Priority order:
        // 1) Build points from valid vertices (grid-consistent)
        // 2) If empty, fallback to payload.points
        normalizePoints(payload) {
            const vertices = Array.isArray(payload.vertices) ? payload.vertices : [];
            const pointsFromPayload = Array.isArray(payload.points) ? payload.points : [];
            const points = [];

            // vertices includes invalid cells; only keep valid finite values.
            // HOT PATH: O(N) scan over all vertices (potentially tens/hundreds of thousands).
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

            // Fallback path when vertices is absent or all invalid.
            // HOT PATH: second O(N) scan over points if first pass produced nothing.
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

        // Compute global stats used by coloring (min/max/range) and centering.
        computePointStats(points) {
            let minZ = Number.POSITIVE_INFINITY;
            let maxZ = Number.NEGATIVE_INFINITY;
            let sumX = 0;
            let sumY = 0;

            // HOT PATH: full pass for min/max/center stats; scales linearly with point count.
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

            // If all z values are invalid, provide a safe default range to avoid division by zero.
            if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
                minZ = 0;
                maxZ = 1;
            }

            const zRange = Math.max(maxZ - minZ, 1e-9);
            const centerX = sumX / points.length;
            const centerY = sumY / points.length;

            return { minZ, maxZ, zRange, centerX, centerY };
        },

        // Move large world coordinates to a local centered coordinate system.
        // This improves numeric stability and camera usability for large EPSG coordinates.
        buildCenteredPositions(points, centerX, centerY) {
            const positions = new Float32Array(points.length * 3);
            // HOT PATH: large typed-array write loop (3 floats per point).
            for (let i = 0; i < points.length; i += 1) {
                const x = Number(points[i][0]);
                const y = Number(points[i][1]);
                const z = Number(points[i][2]);

                positions[i * 3] = x - centerX;
                positions[i * 3 + 1] = y - centerY;
                positions[i * 3 + 2] = z;
            }
            return positions;
        },
    };

    // Module 2: mesh/geometry building utilities.
    const MeshModule = {
        // Map normalized elevation ratio t to RGB using piecewise linear interpolation.
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

        // Build white point cloud (no per-vertex colors) to reduce visual clutter.
        createWhitePointCloud(positions) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

            const material = new THREE.PointsMaterial({
                size: 2.8,
                sizeAttenuation: true,
                color: 0xffffff,
                opacity: 0.95,
                transparent: true,
            });

            return new THREE.Points(geometry, material);
        },

        // Reconstruct triangle topology from sampled row/col indices and render colored edges.
        // Steps:
        // 1) Build indexed vertex buffer from valid vertices
        // 2) Generate two triangles per grid quad when all 4 corner indices exist
        // 3) Convert triangle edges to unique line segments (deduplicate shared edges)
        // 4) Color each edge endpoint by elevation
        createColoredTriangleLines(vertices, centerX, centerY, minZ, zRange) {
            if (!Array.isArray(vertices) || !vertices.length) {
                return null;
            }

            // Key format: "sample_row_sample_col" -> local geometry index.
            const keyToGeometryIndex = new Map();
            const geometryPositions = [];
            const geometryVertexColors = [];

            // Convert z to gradient color in [0,1].
            const getColorForZ = (zValue) => {
                const t = THREE.MathUtils.clamp((zValue - minZ) / Math.max(zRange, 1e-9), 0, 1);
                return MeshModule.sampleElevationRamp(t);
            };

            // For each valid cell corner, store centered xyz and its color.
            // HOT PATH: vertex normalization + color generation on all valid vertices.
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
                geometryPositions.push(x - centerX, y - centerY, z);

                const [r, g, b] = getColorForZ(z);
                geometryVertexColors.push(r, g, b);
            }

            // Build triangle index list from grid adjacency.
            // Quad corners: (row,col), (row,col+1), (row+1,col), (row+1,col+1)
            // Triangles: [i00,i01,i11] and [i00,i11,i10]
            const triangleIndices = [];
            // HOT PATH: topology reconstruction loop; map lookups per candidate cell.
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

            // Convert triangle faces to unique line segments.
            const edgePositionArray = [];
            const edgeColorArray = [];
            const edgeSet = new Set();

            // Deduplicate shared edges by sorted pair key.
            const appendEdge = (idxA, idxB) => {
                const edgeKey = idxA < idxB ? `${idxA}_${idxB}` : `${idxB}_${idxA}`;
                if (edgeSet.has(edgeKey)) {
                    return;
                }
                edgeSet.add(edgeKey);

                const baseA = idxA * 3;
                const baseB = idxB * 3;

                // Each line segment has two endpoints; copy xyz and rgb for both.
                // HOT PATH: repeated push operations dominate line-building time.
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

    // Module 3: rendering lifecycle, camera fitting, resize and FPS HUD updates.
    const RenderModule = {
        // Three.js runtime objects are initialized in init().
        scene: null,
        camera: null,
        renderer: null,
        controls: null,

        // Lightweight FPS counter state (updated every 500ms).
        lastFrameAt: performance.now(),
        fpsElapsedMs: 0,
        fpsFrameCount: 0,

        // Initialize scene graph, camera, renderer, controls, lights, and resize hook.
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

            // Basic orientation aid.
            this.scene.add(new THREE.AxesHelper(10));

            // Minimal lighting setup for line/point readability.
            this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
            const dir = new THREE.DirectionalLight(0xffffff, 0.35);
            dir.position.set(30, 60, 20);
            this.scene.add(dir);

            // Keep viewport and projection in sync with browser size.
            window.addEventListener("resize", () => {
                this.camera.aspect = window.innerWidth / window.innerHeight;
                this.camera.updateProjectionMatrix();
                this.renderer.setSize(window.innerWidth, window.innerHeight);
            });
        },

        // Fit camera to point bounds and retarget orbit controls to geometry center.
        fitCameraToPoints(positions) {
            const box = new THREE.Box3();
            const temp = new THREE.Vector3();

            // HOT PATH (one-time per load): bounds scan over all positions.
            for (let i = 0; i < positions.length; i += 3) {
                temp.set(positions[i], positions[i + 1], positions[i + 2]);
                box.expandByPoint(temp);
            }

            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z, 1);
            const distance = maxDim * 1.5;

            // Tune clipping planes from model scale to avoid clipping/far-plane precision issues.
            this.camera.near = Math.max(0.1, maxDim / 10000);
            this.camera.far = maxDim * 120;
            this.camera.position.set(center.x, center.y - distance, center.z + distance * 0.75);
            this.camera.lookAt(center);
            this.camera.updateProjectionMatrix();

            this.controls.target.copy(center);
            this.controls.update();
            // Force one immediate render so first frame uses updated camera state.
            this.renderer.render(this.scene, this.camera);
        },

        // Update load-time HUD text when available.
        setLoadHudText(text) {
            if (hudLoad) {
                hudLoad.textContent = text;
            }
        },

        // Main render loop: controls update + render + rolling FPS display.
        animate() {
            requestAnimationFrame(() => this.animate());

            const now = performance.now();
            const deltaMs = now - this.lastFrameAt;
            this.lastFrameAt = now;

            this.fpsElapsedMs += deltaMs;
            this.fpsFrameCount += 1;

            // Update FPS every 0.5s to reduce flicker while remaining responsive.
            if (this.fpsElapsedMs >= 500) {
                const fps = (this.fpsFrameCount * 1000) / Math.max(this.fpsElapsedMs, 1);
                if (hudFps) {
                    hudFps.textContent = fps.toFixed(1);
                }
                this.fpsElapsedMs = 0;
                this.fpsFrameCount = 0;
            }

            // HOT PATH (every frame): control integration + draw call is the steady-state cost.
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        },
    };

    // App entry:
    // 1) init render context
    // 2) resolve project and fetch payload
    // 3) normalize/build geometry
    // 4) render points + triangle lines
    // 5) fit camera and update load HUD
    async function bootstrap() {
        const loadStartAt = performance.now();
        RenderModule.init();

        projectId = await DataModule.resolveProjectId(projectId, params);
        const payload = await DataModule.fetchTifPayload(projectId);
        // Dev-only logs: useful for inspection, but can be expensive with frequent reloads.
        DataModule.logPayloadSamples(payload);

        const { points, vertices } = DataModule.normalizePoints(payload);
        // Empty dataset: keep app alive, show elapsed load time in HUD.
        if (!points.length) {
            const elapsedMs = performance.now() - loadStartAt;
            RenderModule.setLoadHudText(`${elapsedMs.toFixed(1)} ms (empty)`);
            return;
        }

        const { minZ, zRange, centerX, centerY } = DataModule.computePointStats(points);
        const positions = DataModule.buildCenteredPositions(points, centerX, centerY);

        // Add white point cloud first (base layer).
        const cloud = MeshModule.createWhitePointCloud(positions);
        RenderModule.scene.add(cloud);

        // Add colored triangle edges only when ordered vertices exist.
        const triangleLines = MeshModule.createColoredTriangleLines(vertices, centerX, centerY, minZ, zRange);
        if (triangleLines) {
            RenderModule.scene.add(triangleLines);
        }

        RenderModule.fitCameraToPoints(positions);
        const elapsedMs = performance.now() - loadStartAt;
        RenderModule.setLoadHudText(`${elapsedMs.toFixed(1)} ms`);
    }

    // Keep UI responsive even if bootstrap fails; errors are intentionally swallowed here.
    bootstrap().catch(() => {});
    RenderModule.animate();
})();
