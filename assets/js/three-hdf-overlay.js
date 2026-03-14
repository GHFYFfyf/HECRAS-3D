(function () {
    "use strict";

    const WATER_DEPTH_COLOR_GRADIENT = [
        { t: 0.0, color: [36, 84, 173] },
        { t: 0.35, color: [23, 162, 184] },
        { t: 0.7, color: [56, 189, 136] },
        { t: 1.0, color: [250, 204, 21] },
    ];

    const BASE_POINT_SIZE = 6.0;
    const POINT_SIZE_DEPTH_FACTOR = 0.4;
    const BASE_Z_LIFT = 0.9;
    const DEPTH_Z_LIFT_FACTOR = 0.22;
    const MAX_POINTS_QUERY = 80000;

    // Shared runtime state for overlay lifecycle.
    const RuntimeState = {
        bridge: null,
        projectId: null,
        overlay: null,
        marker: null,
        isLoading: false,
        lastRequestId: 0,
    };

    // Module 1: request bootstrap and backend I/O.
    const DataModule = {
        // Read `project_id` from current URL query string.
        // Returns null when project_id is missing.
        resolveProjectIdFromUrl() {
            const params = new URLSearchParams(window.location.search);
            return params.get("project_id");
        },

        // Resolve the active project id used by this overlay.
        // Priority: URL `project_id` -> first project card from backend.
        // Throws when backend is unavailable or returns an empty project list.
        async resolveProjectIdWithFallback() {
            const fromUrl = this.resolveProjectIdFromUrl();
            if (fromUrl) {
                return fromUrl;
            }

            const response = await fetch("/api/projects/cards", { headers: { Accept: "application/json" } });
            if (!response.ok) {
                throw new Error(`Failed to resolve project id: HTTP ${response.status}`);
            }

            const cards = await response.json();
            if (!Array.isArray(cards) || cards.length === 0) {
                throw new Error("No project found while resolving project id.");
            }
            return String(cards[0].id);
        },

        // Wait until the base three.js scene (created by three-empty.js) is ready.
        // Resolves immediately if the bridge already exists and is flagged as ready.
        // Otherwise listens for `three-base-ready` until timeout.
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

                // Event handler for base scene readiness notification.
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

        // Fetch one HDF water-depth snapshot for a timeline index.
        // `timeIndex = -1` means backend default (usually latest or preferred default frame).
        // Response is expected to be JSON with points, time_index, and time_step_count.
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

        // Print a compact debug sample so we can verify timeline switching quickly.
        // This keeps logs consistent between initial load and slider-driven updates.
        logPointSample(payload) {
            console.log("[hdf-water-depth] points", {
                time_index: payload.time_index,
                point_count: payload.point_count,
                points_sample: Array.isArray(payload.points) ? payload.points.slice(0, 10) : [],
            });
        },
    };

    // Module 2: timeline state and UI.
    const TimelineModule = {
        state: {
            selectedTimeIndex: -1,
            timeStepCount: 0,
        },

        // Create timeline DOM once, then update it for each payload.
        // Also sync shared timeline state and emit `hdf-time-selected` when user commits a new frame.
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
                ].join("");

                document.body.appendChild(root);

                slider = document.getElementById("hdfTimelineSlider");
                valueText = document.getElementById("hdfTimelineValue");
                minText = document.getElementById("hdfTimelineMin");
                maxText = document.getElementById("hdfTimelineMax");
            }

            if (!slider || !valueText || !minText || !maxText) {
                return;
            }

            slider.min = "0";
            slider.max = String(maxIndex);
            slider.step = "1";
            slider.value = String(safeSelected);
            minText.textContent = "0";
            maxText.textContent = String(maxIndex);
            valueText.textContent = `t = ${safeSelected}`;

            // Live-preview selected index while the slider is being dragged.
            slider.oninput = () => {
                const nextIndex = THREE.MathUtils.clamp(Number(slider.value) || 0, 0, maxIndex);
                this.state.selectedTimeIndex = nextIndex;
                valueText.textContent = `t = ${nextIndex}`;
            };

            // Commit selection after drag/release and notify runtime loader.
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
        },
    };

    // Module 3: geometry preparation and overlay drawing.
    const OverlayModule = {
        // Convert normalized depth ratio `t in [0,1]` into RGB using piecewise linear gradient interpolation.
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

        // Transform backend point records into typed arrays used by THREE.BufferGeometry.
        // Input point format: [x, y, bed_z, water_z, depth].
        // Output includes centered XY positions and depth-based colors.
        buildOverlayGeometry(points, centerX, centerY) {
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

                // Recenter XY to the same local space as base terrain and lift Z above terrain.
                positions[cursor * 3] = x - centerX;
                positions[cursor * 3 + 1] = y - centerY;
                positions[cursor * 3 + 2] = waterZ + BASE_Z_LIFT + depthValue * DEPTH_Z_LIFT_FACTOR;

                colors[cursor * 3] = r;
                colors[cursor * 3 + 1] = g;
                colors[cursor * 3 + 2] = b;
                cursor += 1;
            }

            if (cursor === 0) {
                return null;
            }

            const finalPositions = cursor === points.length ? positions : positions.subarray(0, cursor * 3);
            const finalColors = cursor === points.length ? colors : colors.subarray(0, cursor * 3);

            return {
                positions: finalPositions,
                colors: finalColors,
                minDepth,
                maxDepth,
            };
        },

        // Create the overlay points object on first load, then replace geometry on subsequent time steps.
        // This avoids re-adding scene objects and keeps material-level settings stable.
        createOrUpdateWaterDepthOverlay(bridge, payload) {
            const prepared = this.buildOverlayGeometry(payload.points, bridge.centerX || 0, bridge.centerY || 0);
            if (!prepared) {
                return;
            }

            let overlay = RuntimeState.overlay;
            if (!overlay) {
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute("position", new THREE.BufferAttribute(prepared.positions, 3));
                geometry.setAttribute("color", new THREE.BufferAttribute(prepared.colors, 3));

                const material = new THREE.PointsMaterial({
                    size: BASE_POINT_SIZE + POINT_SIZE_DEPTH_FACTOR * Math.sqrt(Math.max(prepared.maxDepth, 0)),
                    sizeAttenuation: true,
                    vertexColors: true,
                    transparent: true,
                    opacity: 1.0,
                    depthTest: false,
                    depthWrite: false,
                });

                overlay = new THREE.Points(geometry, material);
                overlay.name = "hdfWaterDepthOverlay";
                overlay.renderOrder = 999;
                overlay.frustumCulled = false;
                bridge.scene.add(overlay);
                RuntimeState.overlay = overlay;
            } else {
                overlay.geometry.dispose();
                overlay.geometry = new THREE.BufferGeometry();
                overlay.geometry.setAttribute("position", new THREE.BufferAttribute(prepared.positions, 3));
                overlay.geometry.setAttribute("color", new THREE.BufferAttribute(prepared.colors, 3));
                overlay.material.size = BASE_POINT_SIZE + POINT_SIZE_DEPTH_FACTOR * Math.sqrt(Math.max(prepared.maxDepth, 0));
                overlay.material.needsUpdate = true;
            }

            // Keep bbox computation for local diagnostics parity with previous implementation.
            const bbox = new THREE.Box3().setFromBufferAttribute(overlay.geometry.getAttribute("position"));
            const size = bbox.getSize(new THREE.Vector3());
            const center = bbox.getCenter(new THREE.Vector3());
            void size;
            void center;

            const firstX = prepared.positions[0];
            const firstY = prepared.positions[1];
            const firstZ = prepared.positions[2];
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

    // Module 4: event binding and runtime flow control.
    const RuntimeModule = {
        // Load one timeline frame and render it.
        // Request id guard ensures stale async responses do not overwrite newer user selections.
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

        // Subscribe to timeline selection events emitted by TimelineModule UI.
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

        // Full startup sequence:
        // 1) wait for base scene bridge
        // 2) resolve project id
        // 3) load default frame
        // 4) initialize UI and overlay
        // 5) enable timeline-driven updates
        async bootstrap() {
            const bridge = await DataModule.waitForBaseScene(8000);
            const projectId = await DataModule.resolveProjectIdWithFallback();
            RuntimeState.bridge = bridge;
            RuntimeState.projectId = projectId;

            const payload = await DataModule.fetchWaterDepthPayload(projectId, -1);
            TimelineModule.createOrUpdateUi(payload.time_step_count, payload.time_index);
            DataModule.logPointSample(payload);

            if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
                return;
            }

            OverlayModule.createOrUpdateWaterDepthOverlay(bridge, payload);
            this.bindTimelineEvent();
        },
    };
    RuntimeModule.bootstrap().catch((error) => {
        void error;
    });
})();
