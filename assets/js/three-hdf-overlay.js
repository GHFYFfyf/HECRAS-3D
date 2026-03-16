(function () {
    "use strict";

    const WATER_DEPTH_COLOR_GRADIENT = [
        { t: 0.0, color: [36, 84, 173] },
        { t: 0.35, color: [23, 162, 184] },
        { t: 0.7, color: [56, 189, 136] },
        { t: 1.0, color: [250, 204, 21] },
    ];

    // Keep source XY in original world coordinates, but force-lift water surface by +100m in Z.
    const BASE_Z_LIFT = 0.0;
    const DEPTH_Z_LIFT_FACTOR = 0.0;
    const WATER_FORCED_Z_LIFT = 0.0;
    const MAX_POINTS_QUERY = 80000;
    const SURFACE_GRID_MIN = 72;
    const SURFACE_GRID_MAX = 220;
    const SURFACE_HOLE_FILL_PASSES = 4;
    const SURFACE_SMOOTH_PASSES = 2;
    const RENDER_MODE_AUTO = "auto";
    const RENDER_MODE_SURFACE = "surface";
    const RENDER_MODE_POINTS = "points";

    /**
     * RuntimeState
     * Function: Shared mutable state for overlay lifecycle.
     * Key variables:
     * - bridge: handle to base three.js scene/camera/renderer.
     * - projectId: active project id used for backend requests.
     * - overlay: current THREE.Points or THREE.Mesh instance.
     * - marker: debug sphere pinned to the first rendered point.
     * - renderMode: one of auto/surface/points.
     * - isLoading + lastRequestId: guard against overlapping async updates.
     * Flow role: consumed by all modules as a single source of truth.
     */
    const RuntimeState = {
        bridge: null,
        projectId: null,
        overlay: null,
        marker: null,
        renderMode: RENDER_MODE_AUTO,
        isLoading: false,
        lastRequestId: 0,
    };

    /**
     * DataModule
     * Function: Resolve project/mode and fetch HDF water-depth payloads.
     * Key variables: URL params, backend endpoints, time index.
     * Flow: bootstrap/runtime -> DataModule -> backend JSON -> overlay pipeline.
     */
    const DataModule = {
        /**
         * resolveProjectIdFromUrl
         * Function: Read `project_id` from URL query string.
         * Input: none.
         * Output: string project id or null.
         */
        resolveProjectIdFromUrl() {
            const params = new URLSearchParams(window.location.search);
            return params.get("project_id");
        },

        /**
         * resolveRenderModeFromUrl
         * Function: Parse optional `hdf_mode` from URL.
         * Input: none.
         * Output: `auto`, `surface`, or `points` (defaults to `auto`).
         */
        resolveRenderModeFromUrl() {
            const params = new URLSearchParams(window.location.search);
            const rawMode = String(params.get("hdf_mode") || "").toLowerCase();
            if (rawMode === RENDER_MODE_AUTO || rawMode === RENDER_MODE_SURFACE || rawMode === RENDER_MODE_POINTS) {
                return rawMode;
            }
            return RENDER_MODE_AUTO;
        },

        /**
         * resolveProjectIdWithFallback
         * Function: Determine active project id for this page.
         * Key variables: URL `project_id`, `/api/projects/cards` fallback response.
         * Flow: try URL first, then fetch first card from backend.
         * Input: none.
         * Output: Promise<string> project id.
         */
        async resolveProjectIdWithFallback() {
            const fromUrl = this.resolveProjectIdFromUrl();
            if (fromUrl) {
                return fromUrl;
            }

            // Send: GET /api/projects/cards to backend, requesting project summary list for fallback selection.
            const response = await fetch("/api/projects/cards", { headers: { Accept: "application/json" } });
            if (!response.ok) {
                throw new Error(`Failed to resolve project id: HTTP ${response.status}`);
            }

            // Receive: backend card list JSON, read first `id` as default project target.
            const cards = await response.json();
            if (!Array.isArray(cards) || cards.length === 0) {
                throw new Error("No project found while resolving project id.");
            }
            return String(cards[0].id);
        },

        /**
         * waitForBaseScene
         * Function: Wait for `three-empty.js` to expose a ready scene bridge.
         * Key variables: `window.ThreeOverlayBridge`, `three-base-ready` event, timeout timer.
         * Flow: resolve immediately when bridge is ready; otherwise subscribe and wait.
         * Input: timeoutMs (number).
         * Output: Promise<object> bridge.
         */
        waitForBaseScene(timeoutMs) {
            return new Promise((resolve, reject) => {
                const bridge = window.ThreeOverlayBridge;
                if (bridge && bridge.ready && bridge.scene && bridge.camera && bridge.renderer) {
                    resolve(bridge);
                    return;
                }

                const timer = window.setTimeout(() => {
                    window.removeEventListener("three-base-ready", onReady);
                    reject(new Error("Timed out waiting for base three.js scene."));
                }, timeoutMs);

                function onReady(event) {
                    const nextBridge = event.detail || window.ThreeOverlayBridge;
                    if (!nextBridge || !nextBridge.ready) {
                        return;
                    }
                    window.clearTimeout(timer);
                    window.removeEventListener("three-base-ready", onReady);
                    resolve(nextBridge);
                }

                window.addEventListener("three-base-ready", onReady);
            });
        },

        /**
         * fetchWaterDepthPayload
         * Function: Request one frame of sampled HDF water depth.
         * Key variables: projectId, timeIndex, MAX_POINTS_QUERY, include_dry=false.
         * Flow: build endpoint URL -> fetch -> validate HTTP status -> parse JSON.
         * Input: projectId (string), timeIndex (integer, -1 for backend default).
         * Output: Promise<{points, time_index, time_step_count, ...}>.
         */
        async fetchWaterDepthPayload(projectId, timeIndex) {
            const safeTimeIndex = Number.isInteger(timeIndex) ? timeIndex : -1;
            console.log("[hdf-water-depth] request time_index", safeTimeIndex);
            const response = await fetch(
                `/api/projects/${encodeURIComponent(projectId)}/hdf-water-depth?time_index=${encodeURIComponent(safeTimeIndex)}&max_points=${MAX_POINTS_QUERY}&include_dry=false`,
                { headers: { Accept: "application/json" } },
            );
            if (!response.ok) {
                throw new Error(`Failed to load hdf water depth: HTTP ${response.status}`);
            }
            return response.json();
        },

        /**
         * logPointSample
         * Function: Print a compact console sample for payload diagnostics.
         * Input: payload object.
         * Output: none (side effect: console log).
         */
        logPointSample(payload) {
            console.log("[hdf-water-depth] points", {
                time_index: payload.time_index,
                point_count: payload.point_count,
                points_sample: Array.isArray(payload.points) ? payload.points.slice(0, 10) : [],
            });
        },
    };

    /**
     * TimelineModule
     * Function: Manage timeline/mode UI and expose selected time state.
     * Key variables: selectedTimeIndex, timeStepCount, timeline DOM nodes.
     * Flow: create/update UI -> emit events -> runtime loads selected frame.
     */
    const TimelineModule = {
        state: {
            selectedTimeIndex: -1,
            timeStepCount: 0,
        },

        /**
         * createOrUpdateUi
         * Function: Create timeline controls once, then keep them synced per payload.
         * Key variables: slider min/max/value, mode text, active button styles.
         * Flow: sanitize input -> ensure DOM exists -> update labels -> bind events.
         * Input: timeStepCount (number), selectedTimeIndex (number).
         * Output: none.
         */
        createOrUpdateUi(timeStepCount, selectedTimeIndex) {
            const safeCount = Math.max(1, Number(timeStepCount) || 1);
            const maxIndex = safeCount - 1;
            const safeSelected = THREE.MathUtils.clamp(Number(selectedTimeIndex) || 0, 0, maxIndex);

            this.state.timeStepCount = safeCount;
            this.state.selectedTimeIndex = safeSelected;
            window.HdfTimelineState = this.state;

            let root = document.getElementById("hdfTimelineRoot");
            let slider = document.getElementById("hdfTimelineSlider");
            let valueText = document.getElementById("hdfTimelineValue");
            let minText = document.getElementById("hdfTimelineMin");
            let maxText = document.getElementById("hdfTimelineMax");
            let modeText = document.getElementById("hdfRenderModeValue");
            let autoButton = document.getElementById("hdfModeAuto");
            let surfaceButton = document.getElementById("hdfModeSurface");
            let pointsButton = document.getElementById("hdfModePoints");

            if (!root) {
                root = document.createElement("div");
                root.id = "hdfTimelineRoot";
                root.style.position = "fixed";
                root.style.top = "12px";
                root.style.left = "50%";
                root.style.transform = "translateX(-50%)";
                root.style.width = "min(640px, 72vw)";
                root.style.padding = "10px 12px";
                root.style.borderRadius = "10px";
                root.style.background = "rgba(7, 10, 18, 0.88)";
                root.style.border = "1px solid rgba(255, 255, 255, 0.18)";
                root.style.color = "#dbe5ff";
                root.style.font = "12px/1.45 Menlo, Consolas, monospace";
                root.style.letterSpacing = "0.2px";
                root.style.zIndex = "25";
                root.style.pointerEvents = "auto";

                root.innerHTML = [
                    "<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;\">",
                    "<span>HDF Time</span>",
                    "<span id=\"hdfTimelineValue\">--</span>",
                    "</div>",
                    "<input id=\"hdfTimelineSlider\" type=\"range\" style=\"width:100%;\" />",
                    "<div style=\"display:flex;justify-content:space-between;margin-top:4px;color:#95a4cc;\">",
                    "<span id=\"hdfTimelineMin\">0</span>",
                    "<span id=\"hdfTimelineMax\">0</span>",
                    "</div>",
                    "<div style=\"display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:10px;\">",
                    "<span id=\"hdfRenderModeValue\" style=\"color:#9fb3e4;\">mode: auto</span>",
                    "<div style=\"display:flex;gap:6px;\">",
                    "<button id=\"hdfModeAuto\" type=\"button\" style=\"font:11px/1.2 Menlo,Consolas,monospace;padding:4px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.24);background:transparent;color:#dbe5ff;cursor:pointer;\">AUTO</button>",
                    "<button id=\"hdfModeSurface\" type=\"button\" style=\"font:11px/1.2 Menlo,Consolas,monospace;padding:4px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.24);background:transparent;color:#dbe5ff;cursor:pointer;\">SURFACE</button>",
                    "<button id=\"hdfModePoints\" type=\"button\" style=\"font:11px/1.2 Menlo,Consolas,monospace;padding:4px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.24);background:transparent;color:#dbe5ff;cursor:pointer;\">POINTS</button>",
                    "</div>",
                    "</div>",
                ].join("");

                document.body.appendChild(root);

                slider = document.getElementById("hdfTimelineSlider");
                valueText = document.getElementById("hdfTimelineValue");
                minText = document.getElementById("hdfTimelineMin");
                maxText = document.getElementById("hdfTimelineMax");
                modeText = document.getElementById("hdfRenderModeValue");
                autoButton = document.getElementById("hdfModeAuto");
                surfaceButton = document.getElementById("hdfModeSurface");
                pointsButton = document.getElementById("hdfModePoints");
            }

            if (!slider || !valueText || !minText || !maxText || !modeText || !autoButton || !surfaceButton || !pointsButton) {
                return;
            }

            slider.min = "0";
            slider.max = String(maxIndex);
            slider.step = "1";
            slider.value = String(safeSelected);
            minText.textContent = "0";
            maxText.textContent = String(maxIndex);
            valueText.textContent = `t = ${safeSelected}`;
            modeText.textContent = `mode: ${String(RuntimeState.renderMode).toUpperCase()}`;

            const applyButtonState = (button, active) => {
                button.style.borderColor = active ? "rgba(120, 193, 255, 0.9)" : "rgba(255, 255, 255, 0.24)";
                button.style.color = active ? "#bde7ff" : "#dbe5ff";
                button.style.background = active ? "rgba(63, 124, 201, 0.28)" : "transparent";
            };
            applyButtonState(autoButton, RuntimeState.renderMode === RENDER_MODE_AUTO);
            applyButtonState(surfaceButton, RuntimeState.renderMode === RENDER_MODE_SURFACE);
            applyButtonState(pointsButton, RuntimeState.renderMode === RENDER_MODE_POINTS);

            slider.oninput = () => {
                const nextIndex = THREE.MathUtils.clamp(Number(slider.value) || 0, 0, maxIndex);
                this.state.selectedTimeIndex = nextIndex;
                valueText.textContent = `t = ${nextIndex}`;
            };

            slider.onchange = () => {
                window.dispatchEvent(
                    new CustomEvent("hdf-time-selected", {
                        detail: {
                            timeIndex: this.state.selectedTimeIndex,
                            timeStepCount: this.state.timeStepCount,
                        },
                    }),
                );
            };

            autoButton.onclick = () => {
                window.dispatchEvent(new CustomEvent("hdf-render-mode-changed", { detail: { mode: RENDER_MODE_AUTO } }));
            };
            surfaceButton.onclick = () => {
                window.dispatchEvent(new CustomEvent("hdf-render-mode-changed", { detail: { mode: RENDER_MODE_SURFACE } }));
            };
            pointsButton.onclick = () => {
                window.dispatchEvent(new CustomEvent("hdf-render-mode-changed", { detail: { mode: RENDER_MODE_POINTS } }));
            };
        },
    };

    /**
     * DiagnosticsModule
     * Function: Validate and summarize payload consistency for debugging.
     * Key variables: min/max depth, below-bed counters, finite point count.
     * Flow: analyze numeric fields -> print compact summary.
     */
    const DiagnosticsModule = {
        /**
         * analyzePayload
         * Function: Compute numeric diagnostics from `[x,y,bed,water,depth]` points.
         * Input: payload object.
         * Output: summary object with counts and min/max values.
         */
        analyzePayload(payload) {
            const points = Array.isArray(payload && payload.points) ? payload.points : [];
            let finiteCount = 0;
            let belowBedCount = 0;
            let dryOrNegativeCount = 0;
            let minDepth = Number.POSITIVE_INFINITY;
            let maxDepth = Number.NEGATIVE_INFINITY;
            let minWaterMinusBed = Number.POSITIVE_INFINITY;

            for (let i = 0; i < points.length; i += 1) {
                const point = points[i];
                const bedZ = Number(point[2]);
                const waterZ = Number(point[3]);
                const depthValue = Number(point[4]);
                if (!Number.isFinite(bedZ) || !Number.isFinite(waterZ) || !Number.isFinite(depthValue)) {
                    continue;
                }

                finiteCount += 1;
                minDepth = Math.min(minDepth, depthValue);
                maxDepth = Math.max(maxDepth, depthValue);

                const waterMinusBed = waterZ - bedZ;
                minWaterMinusBed = Math.min(minWaterMinusBed, waterMinusBed);
                if (waterMinusBed < -1e-6) {
                    belowBedCount += 1;
                }
                if (depthValue <= 0) {
                    dryOrNegativeCount += 1;
                }
            }

            return {
                totalPoints: points.length,
                finitePoints: finiteCount,
                belowBedCount,
                dryOrNegativeCount,
                minDepth: Number.isFinite(minDepth) ? minDepth : null,
                maxDepth: Number.isFinite(maxDepth) ? maxDepth : null,
                minWaterMinusBed: Number.isFinite(minWaterMinusBed) ? minWaterMinusBed : null,
            };
        },

        /**
         * logSummary
         * Function: Emit diagnostics summary to console.
         * Input: payload object.
         * Output: none (side effect: console log).
         */
        logSummary(payload) {
            const summary = this.analyzePayload(payload);
            console.log("[hdf-water-depth][diagnostics]", {
                time_index: payload.time_index,
                render_mode: RuntimeState.renderMode,
                total_points: summary.totalPoints,
                finite_points: summary.finitePoints,
                below_bed_count: summary.belowBedCount,
                dry_or_negative_depth_count: summary.dryOrNegativeCount,
                min_depth: summary.minDepth,
                max_depth: summary.maxDepth,
                min_water_minus_bed: summary.minWaterMinusBed,
                hint: summary.belowBedCount > 0
                    ? "water_z < bed_z exists in source points; check HDF refs/units."
                    : "source points are physically consistent; buried look is likely terrain baseline or smoothing effect.",
            });
        },
    };

    /**
     * OverlayModule
     * Function: Build render geometry/material and keep scene overlay updated.
     * Key variables: renderMode, prepared geometry, color ramps.
     * Flow: choose geometry path -> create/update scene object -> maintain debug marker.
     */
    const OverlayModule = {
        /**
         * sampleDepthRamp
         * Function: Convert normalized depth ratio to RGB via piecewise interpolation.
         * Input: t in [0,1].
         * Output: [r,g,b] in [0,1].
         */
        sampleDepthRamp(t) {
            if (t <= WATER_DEPTH_COLOR_GRADIENT[0].t) {
                return WATER_DEPTH_COLOR_GRADIENT[0].color.map((value) => value / 255);
            }

            for (let i = 0; i < WATER_DEPTH_COLOR_GRADIENT.length - 1; i += 1) {
                const left = WATER_DEPTH_COLOR_GRADIENT[i];
                const right = WATER_DEPTH_COLOR_GRADIENT[i + 1];
                if (t >= left.t && t <= right.t) {
                    const localT = (t - left.t) / Math.max(right.t - left.t, 1e-9);
                    return [
                        (left.color[0] + (right.color[0] - left.color[0]) * localT) / 255,
                        (left.color[1] + (right.color[1] - left.color[1]) * localT) / 255,
                        (left.color[2] + (right.color[2] - left.color[2]) * localT) / 255,
                    ];
                }
            }

            return WATER_DEPTH_COLOR_GRADIENT[WATER_DEPTH_COLOR_GRADIENT.length - 1].color.map((value) => value / 255);
        },

        /**
         * buildSmoothedSurfaceGeometry
         * Function: Convert irregular wet-cell points into a smooth triangulated surface mesh.
         * Key variables: grid size bounds, hole-fill passes, smoothing passes, depth range.
         * Flow:
         * 1) derive XY/depth bounds
         * 2) bin points to regular grid
         * 3) fill sparse holes from neighbors
         * 4) smooth grid values
         * 5) emit position/color/index buffers
         * Input: points ([[x,y,bed,water,depth],...]), centerX/centerY (reserved for compatibility).
         * Output: geometry descriptor or null when insufficient data.
         */
        buildSmoothedSurfaceGeometry(points, centerX, centerY) {
            if (!Array.isArray(points) || points.length === 0) {
                return null;
            }

            let minX = Number.POSITIVE_INFINITY;
            let maxX = Number.NEGATIVE_INFINITY;
            let minY = Number.POSITIVE_INFINITY;
            let maxY = Number.NEGATIVE_INFINITY;
            let minDepth = Number.POSITIVE_INFINITY;
            let maxDepth = Number.NEGATIVE_INFINITY;

            for (let i = 0; i < points.length; i += 1) {
                const x = Number(points[i][0]);
                const y = Number(points[i][1]);
                const depthValue = Number(points[i][4]);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(depthValue)) {
                    continue;
                }

                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
                minDepth = Math.min(minDepth, depthValue);
                maxDepth = Math.max(maxDepth, depthValue);
            }

            if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
                return null;
            }
            if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth)) {
                return null;
            }

            const rangeX = Math.max(maxX - minX, 1e-6);
            const rangeY = Math.max(maxY - minY, 1e-6);
            const aspect = THREE.MathUtils.clamp(rangeY / rangeX, 0.35, 2.8);
            const baseGrid = THREE.MathUtils.clamp(
                Math.round(Math.sqrt(points.length) * 0.72),
                SURFACE_GRID_MIN,
                SURFACE_GRID_MAX,
            );
            const gridCols = baseGrid;
            const gridRows = THREE.MathUtils.clamp(
                Math.round(baseGrid * aspect),
                SURFACE_GRID_MIN,
                SURFACE_GRID_MAX,
            );
            const cellCount = gridCols * gridRows;

            const waterSum = new Float64Array(cellCount);
            const depthSum = new Float64Array(cellCount);
            const sampleCount = new Uint32Array(cellCount);
            const toIndex = (row, col) => row * gridCols + col;

            for (let i = 0; i < points.length; i += 1) {
                const x = Number(points[i][0]);
                const y = Number(points[i][1]);
                const waterZ = Number(points[i][3]);
                const depthValue = Number(points[i][4]);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(waterZ) || !Number.isFinite(depthValue)) {
                    continue;
                }

                const u = THREE.MathUtils.clamp((x - minX) / rangeX, 0, 1);
                const v = THREE.MathUtils.clamp((y - minY) / rangeY, 0, 1);
                const col = THREE.MathUtils.clamp(Math.round(u * (gridCols - 1)), 0, gridCols - 1);
                const row = THREE.MathUtils.clamp(Math.round(v * (gridRows - 1)), 0, gridRows - 1);
                const index = toIndex(row, col);

                waterSum[index] += waterZ;
                depthSum[index] += depthValue;
                sampleCount[index] += 1;
            }

            const waterGrid = new Float32Array(cellCount);
            const depthGrid = new Float32Array(cellCount);
            const validGrid = new Uint8Array(cellCount);
            for (let i = 0; i < cellCount; i += 1) {
                if (sampleCount[i] > 0) {
                    waterGrid[i] = waterSum[i] / sampleCount[i];
                    depthGrid[i] = depthSum[i] / sampleCount[i];
                    validGrid[i] = 1;
                }
            }

            for (let pass = 0; pass < SURFACE_HOLE_FILL_PASSES; pass += 1) {
                const nextWater = waterGrid.slice();
                const nextDepth = depthGrid.slice();
                const nextValid = validGrid.slice();

                for (let row = 0; row < gridRows; row += 1) {
                    for (let col = 0; col < gridCols; col += 1) {
                        const index = toIndex(row, col);
                        if (validGrid[index]) {
                            continue;
                        }

                        let waterAcc = 0;
                        let depthAcc = 0;
                        let count = 0;
                        for (let dy = -1; dy <= 1; dy += 1) {
                            for (let dx = -1; dx <= 1; dx += 1) {
                                if (dx === 0 && dy === 0) {
                                    continue;
                                }
                                const nr = row + dy;
                                const nc = col + dx;
                                if (nr < 0 || nr >= gridRows || nc < 0 || nc >= gridCols) {
                                    continue;
                                }
                                const nIndex = toIndex(nr, nc);
                                if (!validGrid[nIndex]) {
                                    continue;
                                }
                                waterAcc += waterGrid[nIndex];
                                depthAcc += depthGrid[nIndex];
                                count += 1;
                            }
                        }

                        if (count >= 3) {
                            nextWater[index] = waterAcc / count;
                            nextDepth[index] = depthAcc / count;
                            nextValid[index] = 1;
                        }
                    }
                }

                waterGrid.set(nextWater);
                depthGrid.set(nextDepth);
                validGrid.set(nextValid);
            }

            for (let pass = 0; pass < SURFACE_SMOOTH_PASSES; pass += 1) {
                const nextWater = waterGrid.slice();
                const nextDepth = depthGrid.slice();

                for (let row = 1; row < gridRows - 1; row += 1) {
                    for (let col = 1; col < gridCols - 1; col += 1) {
                        const index = toIndex(row, col);
                        if (!validGrid[index]) {
                            continue;
                        }

                        let weightedWater = 0;
                        let weightedDepth = 0;
                        let weightSum = 0;
                        for (let dy = -1; dy <= 1; dy += 1) {
                            for (let dx = -1; dx <= 1; dx += 1) {
                                const nIndex = toIndex(row + dy, col + dx);
                                if (!validGrid[nIndex]) {
                                    continue;
                                }
                                const weight = (dx === 0 && dy === 0) ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
                                weightedWater += waterGrid[nIndex] * weight;
                                weightedDepth += depthGrid[nIndex] * weight;
                                weightSum += weight;
                            }
                        }

                        if (weightSum > 0) {
                            nextWater[index] = weightedWater / weightSum;
                            nextDepth[index] = weightedDepth / weightSum;
                        }
                    }
                }

                waterGrid.set(nextWater);
                depthGrid.set(nextDepth);
            }

            const positions = new Float32Array(cellCount * 3);
            const colors = new Float32Array(cellCount * 3);
            const indices = [];
            const depthRange = Math.max(maxDepth - minDepth, 1e-9);
            let firstValidIndex = -1;

            for (let row = 0; row < gridRows; row += 1) {
                for (let col = 0; col < gridCols; col += 1) {
                    const index = toIndex(row, col);
                    if (!validGrid[index]) {
                        continue;
                    }

                    if (firstValidIndex < 0) {
                        firstValidIndex = index;
                    }

                    const x = minX + (col / Math.max(gridCols - 1, 1)) * rangeX;
                    const y = minY + (row / Math.max(gridRows - 1, 1)) * rangeY;
                    const depthValue = depthGrid[index];
                    const waterZ = waterGrid[index];
                    const t = THREE.MathUtils.clamp((depthValue - minDepth) / depthRange, 0, 1);
                    const [r, g, b] = this.sampleDepthRamp(t);

                    positions[index * 3] = x;
                    positions[index * 3 + 1] = y;
                    positions[index * 3 + 2] = waterZ + BASE_Z_LIFT + WATER_FORCED_Z_LIFT + depthValue * DEPTH_Z_LIFT_FACTOR;
                    colors[index * 3] = r;
                    colors[index * 3 + 1] = g;
                    colors[index * 3 + 2] = b;
                }
            }

            for (let row = 0; row < gridRows - 1; row += 1) {
                for (let col = 0; col < gridCols - 1; col += 1) {
                    const i00 = toIndex(row, col);
                    const i10 = toIndex(row + 1, col);
                    const i01 = toIndex(row, col + 1);
                    const i11 = toIndex(row + 1, col + 1);
                    if (!validGrid[i00] || !validGrid[i10] || !validGrid[i01] || !validGrid[i11]) {
                        continue;
                    }

                    indices.push(i00, i01, i11);
                    indices.push(i00, i11, i10);
                }
            }

            if (!indices.length || firstValidIndex < 0) {
                return null;
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
            geometry.setIndex(indices);
            geometry.computeVertexNormals();

            return {
                geometry,
                minDepth,
                maxDepth,
                renderMode: "surface",
                firstPosition: [
                    positions[firstValidIndex * 3],
                    positions[firstValidIndex * 3 + 1],
                    positions[firstValidIndex * 3 + 2],
                ],
            };
        },

        /**
         * buildPointFallbackGeometry
         * Function: Build colored point-cloud geometry directly from sampled points.
         * Key variables: depthRange, WATER_FORCED_Z_LIFT.
         * Flow: validate points -> map depth to color -> write typed arrays.
         * Input: points ([[x,y,bed,water,depth],...]), centerX/centerY (reserved).
         * Output: geometry descriptor with renderMode=points, or null.
         */
        buildPointFallbackGeometry(points, centerX, centerY) {
            if (!Array.isArray(points) || points.length === 0) {
                return null;
            }

            let minDepth = Number.POSITIVE_INFINITY;
            let maxDepth = Number.NEGATIVE_INFINITY;
            for (let i = 0; i < points.length; i += 1) {
                const depthValue = Number(points[i][4]);
                if (!Number.isFinite(depthValue)) {
                    continue;
                }
                minDepth = Math.min(minDepth, depthValue);
                maxDepth = Math.max(maxDepth, depthValue);
            }

            if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth)) {
                return null;
            }

            const depthRange = Math.max(maxDepth - minDepth, 1e-9);
            const positions = new Float32Array(points.length * 3);
            const colors = new Float32Array(points.length * 3);
            let cursor = 0;

            for (let i = 0; i < points.length; i += 1) {
                const x = Number(points[i][0]);
                const y = Number(points[i][1]);
                const waterZ = Number(points[i][3]);
                const depthValue = Number(points[i][4]);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(waterZ) || !Number.isFinite(depthValue)) {
                    continue;
                }

                const t = THREE.MathUtils.clamp((depthValue - minDepth) / depthRange, 0, 1);
                const [r, g, b] = this.sampleDepthRamp(t);

                positions[cursor * 3] = x;
                positions[cursor * 3 + 1] = y;
                positions[cursor * 3 + 2] = waterZ + WATER_FORCED_Z_LIFT;
                colors[cursor * 3] = r;
                colors[cursor * 3 + 1] = g;
                colors[cursor * 3 + 2] = b;
                cursor += 1;
            }

            if (cursor === 0) {
                return null;
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                "position",
                new THREE.BufferAttribute(cursor === points.length ? positions : positions.subarray(0, cursor * 3), 3),
            );
            geometry.setAttribute(
                "color",
                new THREE.BufferAttribute(cursor === points.length ? colors : colors.subarray(0, cursor * 3), 3),
            );

            return {
                geometry,
                minDepth,
                maxDepth,
                renderMode: "points",
                firstPosition: [geometry.getAttribute("position").array[0], geometry.getAttribute("position").array[1], geometry.getAttribute("position").array[2]],
            };
        },

        /**
         * createOrUpdateWaterDepthOverlay
         * Function: Render current payload using selected render mode and update existing scene object.
         * Key variables: RuntimeState.renderMode, RuntimeState.overlay.
         * Flow: choose prepared geometry -> reconcile object type (points/mesh) -> update geometry/material.
         * Input: bridge (scene handles), payload (water depth frame).
         * Output: none.
         */
        createOrUpdateWaterDepthOverlay(bridge, payload) {
            const points = Array.isArray(payload && payload.points) ? payload.points : [];
            let prepared = null;

            if (RuntimeState.renderMode === RENDER_MODE_POINTS) {
                prepared = this.buildPointFallbackGeometry(points, bridge.centerX || 0, bridge.centerY || 0);
            } else if (RuntimeState.renderMode === RENDER_MODE_SURFACE) {
                prepared = this.buildSmoothedSurfaceGeometry(points, bridge.centerX || 0, bridge.centerY || 0);
                if (!prepared) {
                    prepared = this.buildPointFallbackGeometry(points, bridge.centerX || 0, bridge.centerY || 0);
                }
            } else {
                prepared = this.buildSmoothedSurfaceGeometry(points, bridge.centerX || 0, bridge.centerY || 0);
                if (!prepared) {
                    prepared = this.buildPointFallbackGeometry(points, bridge.centerX || 0, bridge.centerY || 0);
                }
            }

            if (!prepared) {
                return;
            }

            const needsPointsObject = prepared.renderMode === "points";
            let overlay = RuntimeState.overlay;
            if (overlay && Boolean(overlay.isPoints) !== needsPointsObject) {
                overlay.geometry.dispose();
                overlay.material.dispose();
                bridge.scene.remove(overlay);
                RuntimeState.overlay = null;
                overlay = null;
            }

            if (!overlay) {
                if (needsPointsObject) {
                    const pointMaterial = new THREE.PointsMaterial({
                        size: 4.2,
                        sizeAttenuation: true,
                        vertexColors: true,
                        transparent: true,
                        opacity: 0.92,
                        depthTest: false,
                    });
                    overlay = new THREE.Points(prepared.geometry, pointMaterial);
                } else {
                    const meshMaterial = new THREE.MeshPhongMaterial({
                        vertexColors: true,
                        transparent: true,
                        opacity: 0.9,
                        shininess: 26,
                        specular: 0x223344,
                        side: THREE.DoubleSide,
                    });
                    overlay = new THREE.Mesh(prepared.geometry, meshMaterial);
                }
                overlay.name = "hdfWaterDepthOverlay";
                overlay.renderOrder = 999;
                overlay.frustumCulled = false;
                bridge.scene.add(overlay);
                RuntimeState.overlay = overlay;
            } else {
                overlay.geometry.dispose();
                overlay.geometry = prepared.geometry;
                if (overlay.isPoints) {
                    overlay.material.size = 4.2;
                }
                overlay.material.needsUpdate = true;
            }

            const bbox = new THREE.Box3().setFromBufferAttribute(overlay.geometry.getAttribute("position"));
            const size = bbox.getSize(new THREE.Vector3());
            const center = bbox.getCenter(new THREE.Vector3());
            void size;
            void center;

            const firstX = prepared.firstPosition[0];
            const firstY = prepared.firstPosition[1];
            const firstZ = prepared.firstPosition[2];
            let marker = RuntimeState.marker;
            if (!marker) {
                marker = new THREE.Mesh(
                    new THREE.SphereGeometry(4, 12, 12),
                    new THREE.MeshBasicMaterial({ color: 0xff00ff }),
                );
                marker.name = "hdfWaterDepthDebugMarker";
                marker.renderOrder = 1000;
                bridge.scene.add(marker);
                RuntimeState.marker = marker;
            }
            marker.position.set(firstX, firstY, firstZ + 1.0);
        },
    };

    /**
     * RuntimeModule
     * Function: Coordinate events, async frame loading, and app startup.
     * Key variables: RuntimeState request guard and selected timeline index.
     * Flow: bootstrap -> bind listeners -> fetch frame -> render overlay.
     */
    const RuntimeModule = {
        /**
         * setRenderMode
         * Function: Normalize and apply render mode.
         * Input: mode candidate string.
         * Output: boolean; true when mode changed, false when unchanged.
         */
        setRenderMode(mode) {
            const normalized = String(mode || "").toLowerCase();
            const nextMode = (normalized === RENDER_MODE_AUTO || normalized === RENDER_MODE_SURFACE || normalized === RENDER_MODE_POINTS)
                ? normalized
                : RENDER_MODE_AUTO;

            if (RuntimeState.renderMode === nextMode) {
                return false;
            }
            RuntimeState.renderMode = nextMode;
            return true;
        },

        /**
         * loadAndRenderTimeIndex
         * Function: Fetch selected frame and push it through diagnostics/UI/overlay pipeline.
         * Key variables: isLoading, lastRequestId guard against stale responses.
         * Flow: request -> stale-check -> diagnostics + UI sync -> overlay update.
         * Input: timeIndex (integer).
         * Output: Promise<void>.
         */
        async loadAndRenderTimeIndex(timeIndex) {
            if (!RuntimeState.bridge || !RuntimeState.projectId || RuntimeState.isLoading) {
                return;
            }

            RuntimeState.isLoading = true;
            const requestId = RuntimeState.lastRequestId + 1;
            RuntimeState.lastRequestId = requestId;

            try {
                const payload = await DataModule.fetchWaterDepthPayload(RuntimeState.projectId, timeIndex);
                if (requestId !== RuntimeState.lastRequestId) {
                    return;
                }

                DataModule.logPointSample(payload);
                DiagnosticsModule.logSummary(payload);
                TimelineModule.createOrUpdateUi(payload.time_step_count, payload.time_index);

                if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
                    return;
                }

                OverlayModule.createOrUpdateWaterDepthOverlay(RuntimeState.bridge, payload);
            } catch (error) {
                void error;
            } finally {
                RuntimeState.isLoading = false;
            }
        },

        /**
         * bindTimelineEvent
         * Function: Listen to `hdf-time-selected` and trigger frame reload.
         * Input/Output: none.
         */
        bindTimelineEvent() {
            window.addEventListener("hdf-time-selected", (event) => {
                const detail = event && event.detail ? event.detail : {};
                const nextTimeIndex = Number(detail.timeIndex);
                if (!Number.isFinite(nextTimeIndex)) {
                    return;
                }
                void this.loadAndRenderTimeIndex(Math.trunc(nextTimeIndex));
            });
        },

        /**
         * bindRenderModeEvent
         * Function: Listen to render-mode changes and re-render current frame.
         * Input/Output: none.
         */
        bindRenderModeEvent() {
            window.addEventListener("hdf-render-mode-changed", (event) => {
                const detail = event && event.detail ? event.detail : {};
                const nextMode = detail.mode;
                if (!this.setRenderMode(nextMode)) {
                    TimelineModule.createOrUpdateUi(TimelineModule.state.timeStepCount, TimelineModule.state.selectedTimeIndex);
                    return;
                }

                console.log("[hdf-water-depth] render mode changed", RuntimeState.renderMode);
                TimelineModule.createOrUpdateUi(TimelineModule.state.timeStepCount, TimelineModule.state.selectedTimeIndex);
                const currentTimeIndex = Math.trunc(TimelineModule.state.selectedTimeIndex);
                void this.loadAndRenderTimeIndex(Number.isFinite(currentTimeIndex) ? currentTimeIndex : -1);
            });
        },

        /**
         * bindDebugShortcuts
         * Function: Placeholder for optional keyboard debug controls.
         * Input/Output: none.
         */
        bindDebugShortcuts() {
            // Intentionally kept empty.
        },

        /**
         * bootstrap
         * Function: Initialize module wiring and render initial frame.
         * Flow:
         * 1) wait for base scene
         * 2) resolve project and mode
         * 3) fetch default frame
         * 4) create UI and bind events
         * 5) render first overlay
         * Input: none.
         * Output: Promise<void>.
         */
        async bootstrap() {
            const bridge = await DataModule.waitForBaseScene(8000);
            const projectId = await DataModule.resolveProjectIdWithFallback();
            this.setRenderMode(DataModule.resolveRenderModeFromUrl());
            RuntimeState.bridge = bridge;
            RuntimeState.projectId = projectId;

            const payload = await DataModule.fetchWaterDepthPayload(projectId, -1);
            TimelineModule.createOrUpdateUi(payload.time_step_count, payload.time_index);
            DataModule.logPointSample(payload);
            DiagnosticsModule.logSummary(payload);

            this.bindTimelineEvent();
            this.bindRenderModeEvent();
            this.bindDebugShortcuts();

            if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
                return;
            }

            OverlayModule.createOrUpdateWaterDepthOverlay(bridge, payload);
        },
    };
    RuntimeModule.bootstrap().catch((error) => {
        void error;
    });
})();
