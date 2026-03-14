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

    const HdfTimelineState = {
        selectedTimeIndex: -1,
        timeStepCount: 0,
    };

    const HdfOverlayRuntime = {
        bridge: null,
        projectId: null,
        overlay: null,
        marker: null,
        isLoading: false,
        lastRequestId: 0,
    };

    function resolveProjectId() {
        const params = new URLSearchParams(window.location.search);
        return params.get("project_id");
    }

    async function resolveProjectIdWithFallback() {
        const fromUrl = resolveProjectId();
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
    }

    function sampleDepthRamp(t) {
        if (t <= WATER_DEPTH_COLOR_GRADIENT[0].t) {
            return WATER_DEPTH_COLOR_GRADIENT[0].color.map((v) => v / 255);
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

        return WATER_DEPTH_COLOR_GRADIENT[WATER_DEPTH_COLOR_GRADIENT.length - 1].color.map((v) => v / 255);
    }

    function waitForBaseScene(timeoutMs) {
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
    }

    async function fetchWaterDepthPayload(projectId, timeIndex) {
        const safeTimeIndex = Number.isInteger(timeIndex) ? timeIndex : -1;
        // Debug 1/2: current timeline tick passed to backend.
        console.log("[hdf-water-depth] request time_index", safeTimeIndex);
        const response = await fetch(
            `/api/projects/${encodeURIComponent(projectId)}/hdf-water-depth?time_index=${encodeURIComponent(safeTimeIndex)}&max_points=80000&include_dry=false`,
            { headers: { Accept: "application/json" } },
        );
        if (!response.ok) {
            throw new Error(`Failed to load hdf water depth: HTTP ${response.status}`);
        }
        return response.json();
    }

    function createOrUpdateTimelineUi(timeStepCount, selectedTimeIndex) {
        const safeCount = Math.max(1, Number(timeStepCount) || 1);
        const maxIndex = safeCount - 1;
        const safeSelected = THREE.MathUtils.clamp(Number(selectedTimeIndex) || 0, 0, maxIndex);

        HdfTimelineState.timeStepCount = safeCount;
        HdfTimelineState.selectedTimeIndex = safeSelected;
        window.HdfTimelineState = HdfTimelineState;

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

        const onSliderInput = () => {
            const nextIndex = THREE.MathUtils.clamp(Number(slider.value) || 0, 0, maxIndex);
            HdfTimelineState.selectedTimeIndex = nextIndex;
            valueText.textContent = `t = ${nextIndex}`;
        };

        const onSliderChange = () => {
            window.dispatchEvent(
                new CustomEvent("hdf-time-selected", {
                    detail: {
                        timeIndex: HdfTimelineState.selectedTimeIndex,
                        timeStepCount: HdfTimelineState.timeStepCount,
                    },
                }),
            );
        };

        slider.oninput = onSliderInput;
        slider.onchange = onSliderChange;
    }

    function buildOverlayGeometry(points, centerX, centerY) {
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
            const [r, g, b] = sampleDepthRamp(t);

            positions[cursor * 3] = x - centerX;
            positions[cursor * 3 + 1] = y - centerY;
            // Visual lift: keep relative depth pattern but separate the layer from terrain.
            const liftedZ = waterZ + BASE_Z_LIFT + depthValue * DEPTH_Z_LIFT_FACTOR;
            positions[cursor * 3 + 2] = liftedZ;

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
    }

    function createOrUpdateWaterDepthOverlay(bridge, payload) {
        const prepared = buildOverlayGeometry(payload.points, bridge.centerX || 0, bridge.centerY || 0);
        if (!prepared) {
            return;
        }

        let overlay = HdfOverlayRuntime.overlay;
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
            HdfOverlayRuntime.overlay = overlay;
        } else {
            overlay.geometry.dispose();
            overlay.geometry = new THREE.BufferGeometry();
            overlay.geometry.setAttribute("position", new THREE.BufferAttribute(prepared.positions, 3));
            overlay.geometry.setAttribute("color", new THREE.BufferAttribute(prepared.colors, 3));
            overlay.material.size = BASE_POINT_SIZE + POINT_SIZE_DEPTH_FACTOR * Math.sqrt(Math.max(prepared.maxDepth, 0));
            overlay.material.needsUpdate = true;
        }

        const bbox = new THREE.Box3().setFromBufferAttribute(overlay.geometry.getAttribute("position"));
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());

        // Diagnostic marker: first water-depth point as bright magenta sphere for quick visibility check.
        const firstX = prepared.positions[0];
        const firstY = prepared.positions[1];
        const firstZ = prepared.positions[2];
        let marker = HdfOverlayRuntime.marker;
        if (!marker) {
            marker = new THREE.Mesh(
                new THREE.SphereGeometry(4, 12, 12),
                new THREE.MeshBasicMaterial({ color: 0xff00ff }),
            );
            marker.name = "hdfWaterDepthDebugMarker";
            marker.renderOrder = 1000;
            bridge.scene.add(marker);
            HdfOverlayRuntime.marker = marker;
        }
        marker.position.set(firstX, firstY, firstZ + 1.0);

        // console.log("[hdf-water-depth] overlay", {
        //     point_count: payload.point_count,
        //     stride: payload.stride,
        //     time_index: payload.time_index,
        //     min_depth: prepared.minDepth,
        //     max_depth: prepared.maxDepth,
        //     overlay_bbox_center: { x: center.x, y: center.y, z: center.z },
        //     overlay_bbox_size: { x: size.x, y: size.y, z: size.z },
        //     bridge_center: { x: bridge.centerX || 0, y: bridge.centerY || 0 },
        //     camera_position: {
        //         x: bridge.camera && bridge.camera.position ? bridge.camera.position.x : null,
        //         y: bridge.camera && bridge.camera.position ? bridge.camera.position.y : null,
        //         z: bridge.camera && bridge.camera.position ? bridge.camera.position.z : null,
        //     },
        //     sample: Array.isArray(payload.points) ? payload.points.slice(0, 5) : [],
        // });
    }

    async function loadAndRenderTimeIndex(timeIndex) {
        if (!HdfOverlayRuntime.bridge || !HdfOverlayRuntime.projectId || HdfOverlayRuntime.isLoading) {
            return;
        }

        HdfOverlayRuntime.isLoading = true;
        const requestId = HdfOverlayRuntime.lastRequestId + 1;
        HdfOverlayRuntime.lastRequestId = requestId;

        try {
            const payload = await fetchWaterDepthPayload(HdfOverlayRuntime.projectId, timeIndex);
            if (requestId !== HdfOverlayRuntime.lastRequestId) {
                return;
            }

            // Debug 2/2: points snapshot for current time tick.
            console.log("[hdf-water-depth] points", {
                time_index: payload.time_index,
                point_count: payload.point_count,
                points_sample: Array.isArray(payload.points) ? payload.points.slice(0, 10) : [],
            });

            createOrUpdateTimelineUi(payload.time_step_count, payload.time_index);

            if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
                // console.warn("[hdf-water-depth] empty payload", payload);
                return;
            }

            createOrUpdateWaterDepthOverlay(HdfOverlayRuntime.bridge, payload);
        } catch (error) {
            // console.warn("[hdf-water-depth] failed loading selected time", {
            //     requested_time_index: timeIndex,
            //     error,
            // });
        } finally {
            HdfOverlayRuntime.isLoading = false;
        }
    }

    async function bootstrapHdfOverlay() {
        const bridge = await waitForBaseScene(8000);
        // Resolve from URL first, fallback to /api/projects/cards to avoid race with URL update timing.
        const projectId = await resolveProjectIdWithFallback();
        HdfOverlayRuntime.bridge = bridge;
        HdfOverlayRuntime.projectId = projectId;

        const payload = await fetchWaterDepthPayload(projectId, -1);
        createOrUpdateTimelineUi(payload.time_step_count, payload.time_index);
        // console.log("[hdf-water-depth] payload(full)", payload);
        // console.log("[hdf-water-depth] payload(summary)", {
        //     project_id: payload.project_id,
        //     time_index: payload.time_index,
        //     time_step_count: payload.time_step_count,
        //     point_count: payload.point_count,
        //     stride: payload.stride,
        //     metadata: payload.metadata,
        // });
        // console.log(
        //     "[hdf-water-depth] payload(points sample)",
        //     Array.isArray(payload.points) ? payload.points.slice(0, 10) : [],
        // );

        // Keep behavior consistent with timeline changes: print the same points debug at initial load.
        console.log("[hdf-water-depth] points", {
            time_index: payload.time_index,
            point_count: payload.point_count,
            points_sample: Array.isArray(payload.points) ? payload.points.slice(0, 10) : [],
        });

        if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
            // console.warn("[hdf-water-depth] empty payload", payload);
            return;
        }

        createOrUpdateWaterDepthOverlay(bridge, payload);

        window.addEventListener("hdf-time-selected", (event) => {
            const detail = event && event.detail ? event.detail : {};
            const nextTimeIndex = Number(detail.timeIndex);
            if (!Number.isFinite(nextTimeIndex)) {
                return;
            }
            void loadAndRenderTimeIndex(Math.trunc(nextTimeIndex));
        });
    }

    bootstrapHdfOverlay().catch((error) => {
        // console.warn("[hdf-water-depth] overlay failed", error);
    });
})();
