(function () {
    "use strict";

    const WATER_DEPTH_COLOR_GRADIENT = [
        { t: 0.0, color: [205, 235, 255] },
        { t: 0.18, color: [145, 205, 250] },
        { t: 0.36, color: [90, 170, 240] },
        { t: 0.54, color: [46, 128, 222] },
        { t: 0.72, color: [24, 92, 190] },
        { t: 0.88, color: [14, 58, 140] },
        { t: 1.0, color: [8, 28, 88] },
    ];

    // Keep source XY in original world coordinates, but force-lift water surface by +100m in Z.
    const BASE_Z_LIFT = 0.0;
    const DEPTH_Z_LIFT_FACTOR = 0.0;
    const WATER_FORCED_Z_LIFT = 0.0;
    const MAX_POINTS_QUERY = 80000;
    const HDF_INITIAL_TIME_INDEX = 0;
    const HDF_INCLUDE_DRY_DEFAULT = false;
    const HDF_MIN_DEPTH_DEFAULT = 0.05;
    const HDF_PLAY_INTERVAL_MS_DEFAULT = 48;
    const HDF_PLAY_INTERVAL_MS_MIN = 16;
    const HDF_PLAY_INTERVAL_MS_MAX = 1000;
    const HDF_PAYLOAD_CACHE_LIMIT = 20;
    const HDF_PREFETCH_AHEAD_COUNT = 2;
    const HDF_VERBOSE_FRAME_LOG = false;
    const HDF_LOAD_ENABLED = false;
    const AUTO_WRITE_WHEN_DRAWCALLS_EQ = 1;
    const AUTO_WRITE_COOLDOWN_MS = 12000;
    const SURFACE_GRID_MIN = 96;
    const SURFACE_GRID_MAX = 320;
    const SURFACE_GRID_MAX_HIGH_DENSITY = 220;
    const SURFACE_HOLE_FILL_PASSES = 7;
    const SURFACE_SMOOTH_PASSES = 3;
    const SURFACE_HIGH_DENSITY_POINT_THRESHOLD = 60000;
    const RENDER_MODE_AUTO = "auto";
    const RENDER_MODE_SURFACE = "surface";
    const RENDER_MODE_POINTS = "points";

    const perfDom = {
        dataGen: document.getElementById("perfDataGen"),
        backendTransfer: document.getElementById("perfBackendTransfer"),
        frontendFetch: document.getElementById("perfFrontendFetch"),
        frontendParse: document.getElementById("perfFrontendParse"),
        frontendRender: document.getElementById("perfFrontendRender"),
        tti: document.getElementById("perfTTI"),
        ttiInit: document.getElementById("perfTTIInit"),
        ttiProject: document.getElementById("perfTTIProject"),
        ttiMeta: document.getElementById("perfTTIMeta"),
        ttiTiles: document.getElementById("perfTTITiles"),
        ttiRebuild: document.getElementById("perfTTIRebuild"),
        realtimeFps: document.getElementById("perfRealtimeFps"),
        drawCalls: document.getElementById("perfDrawCalls"),
        triangles: document.getElementById("perfTriangles"),
        stage: document.getElementById("perfStage"),
    };
    const exportDom = {
        button: document.getElementById("writeXnBtn"),
        status: document.getElementById("writeXnStatus"),
    };

    const setPerfText = (el, text) => {
        if (el) {
            el.textContent = text;
        }
    };

    const formatMs = (value) => `${Number(value).toFixed(1)} ms`;
    const parseNumericText = (value) => {
        const num = Number.parseFloat(String(value || "").replace(/[^\d.+-]/g, ""));
        return Number.isFinite(num) ? num : null;
    };

    const parseServerTiming = (headerValue) => {
        const result = { total: 0, gen: 0 };
        const text = String(headerValue || "");
        const totalMatch = text.match(/total;dur=([0-9.]+)/i);
        const genMatch = text.match(/gen;dur=([0-9.]+)/i);
        if (totalMatch) {
            result.total = Number(totalMatch[1]) || 0;
        }
        if (genMatch) {
            result.gen = Number(genMatch[1]) || 0;
        }
        return result;
    };

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
        renderMode: RENDER_MODE_POINTS,
        cacheMode: "warm",
        isLoading: false,
        lastRequestId: 0,
        isPlaying: false,
        playbackTimerId: 0,
        playbackIntervalMs: HDF_PLAY_INTERVAL_MS_DEFAULT,
        lastPayload: null,
        autoWriteTimerId: 0,
        autoWriteInFlight: false,
        lastAutoWriteAt: 0,
        lastObservedDrawCalls: null,
    };

    /**
     * DataModule
     * Function: Resolve project/mode and fetch HDF water-depth payloads.
     * Key variables: URL params, backend endpoints, time index.
     * Flow: bootstrap/runtime -> DataModule -> backend JSON -> overlay pipeline.
     */
    const DataModule = {
        state: {
            payloadCache: new Map(),
            payloadCacheOrder: [],
            inFlightRequests: new Map(),
        },

        buildPayloadCacheKey(projectId, timeIndex) {
            return `${String(projectId)}|cache:${RuntimeState.cacheMode}|t:${Math.trunc(timeIndex)}`;
        },

        getCachedPayload(cacheKey) {
            if (!cacheKey) {
                return null;
            }
            return this.state.payloadCache.get(cacheKey) || null;
        },

        cachePayload(cacheKey, payload) {
            if (!cacheKey || !payload) {
                return;
            }
            if (this.state.payloadCache.has(cacheKey)) {
                const existedIndex = this.state.payloadCacheOrder.indexOf(cacheKey);
                if (existedIndex >= 0) {
                    this.state.payloadCacheOrder.splice(existedIndex, 1);
                }
            }
            this.state.payloadCache.set(cacheKey, payload);
            this.state.payloadCacheOrder.push(cacheKey);

            while (this.state.payloadCacheOrder.length > HDF_PAYLOAD_CACHE_LIMIT) {
                const oldestKey = this.state.payloadCacheOrder.shift();
                if (!oldestKey) {
                    continue;
                }
                this.state.payloadCache.delete(oldestKey);
            }
        },

        clearPayloadCache() {
            this.state.payloadCache.clear();
            this.state.payloadCacheOrder = [];
            this.state.inFlightRequests.clear();
        },

        prefetchWaterDepthPayload(projectId, timeIndex) {
            if (RuntimeState.cacheMode === "cold") {
                return;
            }
            const safeTimeIndex = Number.isInteger(timeIndex) ? timeIndex : Number.NaN;
            if (!Number.isFinite(safeTimeIndex) || safeTimeIndex < 0) {
                return;
            }

            void this.fetchWaterDepthPayload(projectId, safeTimeIndex, {
                isPrefetch: true,
                allowUiPerfWrite: false,
            }).catch((error) => {
                void error;
            });
        },

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
         * Output: `auto`, `surface`, or `points` (defaults to `points`).
         */
        resolveRenderModeFromUrl() {
            const params = new URLSearchParams(window.location.search);
            const rawMode = String(params.get("hdf_mode") || "").toLowerCase();
            if (rawMode === RENDER_MODE_AUTO || rawMode === RENDER_MODE_SURFACE || rawMode === RENDER_MODE_POINTS) {
                return rawMode;
            }
            return RENDER_MODE_POINTS;
        },

        resolveCacheModeFromUrl() {
            const params = new URLSearchParams(window.location.search);
            const rawMode = String(params.get("hdf_cache_mode") || "warm").toLowerCase();
            if (rawMode === "cold" || rawMode === "warm") {
                return rawMode;
            }
            return "warm";
        },

        resolvePlaybackIntervalFromUrl() {
            const params = new URLSearchParams(window.location.search);
            const rawValue = Number(params.get("hdf_play_interval_ms"));
            if (!Number.isFinite(rawValue)) {
                return HDF_PLAY_INTERVAL_MS_DEFAULT;
            }
            const clamped = THREE.MathUtils.clamp(
                Math.trunc(rawValue),
                HDF_PLAY_INTERVAL_MS_MIN,
                HDF_PLAY_INTERVAL_MS_MAX,
            );
            return clamped;
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
        async fetchWaterDepthPayload(projectId, timeIndex, options = {}) {
            const safeTimeIndex = Number.isInteger(timeIndex) ? timeIndex : HDF_INITIAL_TIME_INDEX;
            const useBackendCache = RuntimeState.cacheMode !== "cold";
            const allowUiPerfWrite = options.allowUiPerfWrite !== false;
            const useLocalCache = safeTimeIndex >= 0 && useBackendCache;
            const cacheKey = useLocalCache ? this.buildPayloadCacheKey(projectId, safeTimeIndex) : null;

            if (useLocalCache) {
                const cachedPayload = this.getCachedPayload(cacheKey);
                if (cachedPayload) {
                    return cachedPayload;
                }
                const inFlight = this.state.inFlightRequests.get(cacheKey);
                if (inFlight) {
                    return inFlight;
                }
            }

            if (!options.isPrefetch) {
                console.log("[hdf-water-depth] request time_index", safeTimeIndex);
            }

            const requestPromise = (async () => {
            const fetchStartAt = performance.now();
            const response = await fetch(
                `/api/projects/${encodeURIComponent(projectId)}/hdf-water-depth?time_index=${encodeURIComponent(safeTimeIndex)}&max_points=${MAX_POINTS_QUERY}&include_dry=${HDF_INCLUDE_DRY_DEFAULT ? "true" : "false"}&min_depth=${encodeURIComponent(HDF_MIN_DEPTH_DEFAULT)}&use_cache=${useBackendCache ? "true" : "false"}`,
                { headers: { Accept: "application/json" } },
            );
            if (!response.ok) {
                throw new Error(`Failed to load hdf water depth: HTTP ${response.status}`);
            }
            const parseStartAt = performance.now();
            const payload = await response.json();
            const parseEndAt = performance.now();

            const serverTiming = parseServerTiming(response.headers.get("server-timing"));
            const fetchMs = parseStartAt - fetchStartAt;
            const parseMs = parseEndAt - parseStartAt;
            const backendTransferMs = Math.max(0, fetchMs - serverTiming.total);

            if (allowUiPerfWrite) {
                setPerfText(perfDom.dataGen, formatMs(serverTiming.gen));
                setPerfText(perfDom.backendTransfer, formatMs(backendTransferMs));
                setPerfText(perfDom.frontendFetch, formatMs(fetchMs));
                setPerfText(perfDom.frontendParse, formatMs(parseMs));
                setPerfText(perfDom.stage, `HDF ${RuntimeState.cacheMode} fetch/parse`);
            }

            if (useLocalCache) {
                this.cachePayload(cacheKey, payload);
            }

            return payload;
            })();

            if (useLocalCache) {
                this.state.inFlightRequests.set(cacheKey, requestPromise);
            }

            try {
                return await requestPromise;
            } finally {
                if (useLocalCache) {
                    this.state.inFlightRequests.delete(cacheKey);
                }
            }
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
                velocity_face_count: payload.velocity_face_count,
                points_sample: Array.isArray(payload.points) ? payload.points.slice(0, 10) : [],
                velocity_faces_sample: Array.isArray(payload.velocity_faces) ? payload.velocity_faces.slice(0, 5) : [],
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
            let playStatusText = document.getElementById("hdfPlaybackStatus");
            let playButton = document.getElementById("hdfPlayButton");
            let pauseButton = document.getElementById("hdfPauseButton");

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
                    "<span id=\"hdfPlaybackStatus\" style=\"color:#9fb3e4;\">playback: paused</span>",
                    "<div style=\"display:flex;gap:6px;\">",
                    "<button id=\"hdfPlayButton\" type=\"button\" style=\"font:11px/1.2 Menlo,Consolas,monospace;padding:4px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.24);background:transparent;color:#dbe5ff;cursor:pointer;\">PLAY</button>",
                    "<button id=\"hdfPauseButton\" type=\"button\" style=\"font:11px/1.2 Menlo,Consolas,monospace;padding:4px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.24);background:transparent;color:#dbe5ff;cursor:pointer;\">PAUSE</button>",
                    "</div>",
                    "</div>",
                    "<div style=\"display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:10px;\">",
                    "<span id=\"hdfRenderModeValue\" style=\"color:#9fb3e4;\">mode: points</span>",
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
                playStatusText = document.getElementById("hdfPlaybackStatus");
                playButton = document.getElementById("hdfPlayButton");
                pauseButton = document.getElementById("hdfPauseButton");
            }

            if (
                !slider
                || !valueText
                || !minText
                || !maxText
                || !modeText
                || !autoButton
                || !surfaceButton
                || !pointsButton
                || !playStatusText
                || !playButton
                || !pauseButton
            ) {
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
            const reachedEnd = safeSelected >= maxIndex;
            playStatusText.textContent = `playback: ${RuntimeState.isPlaying ? "playing" : "paused"}`;
            playButton.disabled = RuntimeState.isPlaying || reachedEnd;
            pauseButton.disabled = !RuntimeState.isPlaying;
            playButton.style.opacity = playButton.disabled ? "0.45" : "1";
            pauseButton.style.opacity = pauseButton.disabled ? "0.45" : "1";
            playButton.style.cursor = playButton.disabled ? "not-allowed" : "pointer";
            pauseButton.style.cursor = pauseButton.disabled ? "not-allowed" : "pointer";

            slider.oninput = () => {
                const nextIndex = THREE.MathUtils.clamp(Number(slider.value) || 0, 0, maxIndex);
                if (RuntimeState.isPlaying) {
                    window.dispatchEvent(new CustomEvent("hdf-pause-request"));
                }
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
            playButton.onclick = () => {
                window.dispatchEvent(new CustomEvent("hdf-play-request"));
            };
            pauseButton.onclick = () => {
                window.dispatchEvent(new CustomEvent("hdf-pause-request"));
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
     * InteractionModule
     * Function: Raycast clicked overlay region and show depth + estimated velocity.
     * Velocity estimation rule: average of around four nearest directional face velocities.
     */
    const InteractionModule = {
        state: {
            raycaster: new THREE.Raycaster(),
            pointerNdc: new THREE.Vector2(),
            isBound: false,
            dom: null,
        },

        formatNumber(value, digits = 3, suffix = "") {
            if (!Number.isFinite(value)) {
                return "--";
            }
            return `${value.toFixed(digits)}${suffix}`;
        },

        ensurePanel() {
            if (this.state.dom) {
                return this.state.dom;
            }

            let root = document.getElementById("hdfPickInfoRoot");
            if (!root) {
                root = document.createElement("aside");
                root.id = "hdfPickInfoRoot";
                root.style.position = "fixed";
                root.style.left = "0px";
                root.style.top = "0px";
                root.style.minWidth = "220px";
                root.style.maxWidth = "min(320px, calc(100vw - 16px))";
                root.style.padding = "10px 12px";
                root.style.borderRadius = "12px";
                root.style.border = "1px solid rgba(255, 255, 255, 0.22)";
                root.style.background = "rgba(7, 10, 18, 0.88)";
                root.style.color = "#dbe5ff";
                root.style.font = "12px/1.5 Menlo, Consolas, monospace";
                root.style.letterSpacing = "0.2px";
                root.style.zIndex = "26";
                root.style.pointerEvents = "none";
                root.style.display = "none";

                root.innerHTML = [
                    "<div style=\"display:flex;justify-content:space-between;gap:8px;\"><span style=\"color:#9fb3e4;\">xy</span><strong id=\"hdfPickXY\">--</strong></div>",
                    "<div style=\"display:flex;justify-content:space-between;gap:8px;\"><span style=\"color:#9fb3e4;\">水深</span><strong id=\"hdfPickDepth\">--</strong></div>",
                    "<div style=\"display:flex;justify-content:space-between;gap:8px;\"><span style=\"color:#9fb3e4;\">流速</span><strong id=\"hdfPickVelocity\">--</strong></div>",
                ].join("");

                document.body.appendChild(root);
            }

            const dom = {
                root,
                xy: document.getElementById("hdfPickXY"),
                depth: document.getElementById("hdfPickDepth"),
                velocity: document.getElementById("hdfPickVelocity"),
            };
            this.state.dom = dom;
            return dom;
        },

        setPanelText(field, text) {
            const dom = this.ensurePanel();
            const node = dom && dom[field] ? dom[field] : null;
            if (node) {
                node.textContent = text;
            }
        },

        showPanelAt(clientX, clientY) {
            const dom = this.ensurePanel();
            if (!dom || !dom.root) {
                return;
            }
            const root = dom.root;
            const offset = 14;
            const margin = 8;

            root.style.visibility = "hidden";
            root.style.display = "block";
            root.style.left = "0px";
            root.style.top = "0px";

            const rect = root.getBoundingClientRect();
            let left = clientX + offset;
            let top = clientY + offset;

            if (left + rect.width + margin > window.innerWidth) {
                left = Math.max(margin, clientX - rect.width - offset);
            }
            if (top + rect.height + margin > window.innerHeight) {
                top = Math.max(margin, clientY - rect.height - offset);
            }

            root.style.left = `${left}px`;
            root.style.top = `${top}px`;
            root.style.visibility = "visible";
        },

        hidePanel() {
            const dom = this.ensurePanel();
            if (dom && dom.root) {
                dom.root.style.display = "none";
            }
        },

        findNearestDepthPoint(points, x, y) {
            const source = Array.isArray(points) ? points : [];
            let bestPoint = null;
            let bestDist2 = Number.POSITIVE_INFINITY;

            for (let i = 0; i < source.length; i += 1) {
                const point = source[i];
                const px = Number(point && point[0]);
                const py = Number(point && point[1]);
                if (!Number.isFinite(px) || !Number.isFinite(py)) {
                    continue;
                }

                const dx = px - x;
                const dy = py - y;
                const dist2 = dx * dx + dy * dy;
                if (dist2 < bestDist2) {
                    bestDist2 = dist2;
                    bestPoint = point;
                }
            }

            if (!bestPoint || !Number.isFinite(bestDist2)) {
                return null;
            }
            return {
                point: bestPoint,
                distanceM: Math.sqrt(bestDist2),
            };
        },

        selectDirectionalVelocityFaces(velocityFaces, x, y, targetCount = 4) {
            const faces = Array.isArray(velocityFaces) ? velocityFaces : [];
            if (!faces.length) {
                return [];
            }

            const directional = {
                posX: null,
                negX: null,
                posY: null,
                negY: null,
            };
            const nearest = [];

            const pushDirectional = (key, sample) => {
                if (!sample) {
                    return;
                }
                if (!directional[key] || sample.dist2 < directional[key].dist2) {
                    directional[key] = sample;
                }
            };

            for (let i = 0; i < faces.length; i += 1) {
                const face = faces[i];
                const fx = Number(face && face[0]);
                const fy = Number(face && face[1]);
                const velocity = Number(face && face[2]);
                if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(velocity)) {
                    continue;
                }

                const dx = fx - x;
                const dy = fy - y;
                const dist2 = dx * dx + dy * dy;
                const sample = { index: i, velocity, dist2 };
                nearest.push(sample);

                if (dx >= 0) {
                    pushDirectional("posX", sample);
                } else {
                    pushDirectional("negX", sample);
                }

                if (dy >= 0) {
                    pushDirectional("posY", sample);
                } else {
                    pushDirectional("negY", sample);
                }
            }

            nearest.sort((a, b) => a.dist2 - b.dist2);
            const selected = [];
            const used = new Set();
            const pushUnique = (sample) => {
                if (!sample || used.has(sample.index)) {
                    return;
                }
                used.add(sample.index);
                selected.push(sample);
            };

            pushUnique(directional.posX);
            pushUnique(directional.negX);
            pushUnique(directional.posY);
            pushUnique(directional.negY);

            for (let i = 0; i < nearest.length && selected.length < targetCount; i += 1) {
                pushUnique(nearest[i]);
            }

            return selected.slice(0, targetCount);
        },

        estimateVelocityByFaces(velocityFaces, x, y) {
            const samples = this.selectDirectionalVelocityFaces(velocityFaces, x, y, 4);
            if (!samples.length) {
                return null;
            }

            let absSum = 0;
            let minDist2 = Number.POSITIVE_INFINITY;
            for (let i = 0; i < samples.length; i += 1) {
                absSum += Math.abs(samples[i].velocity);
                minDist2 = Math.min(minDist2, samples[i].dist2);
            }

            return {
                estimatedVelocity: absSum / samples.length,
                sampleCount: samples.length,
                nearestDistanceM: Number.isFinite(minDist2) ? Math.sqrt(minDist2) : null,
            };
        },

        handleCanvasClick(event) {
            const bridge = RuntimeState.bridge;
            if (!bridge || !bridge.camera || !bridge.renderer || !RuntimeState.overlay) {
                this.hidePanel();
                return;
            }

            const payload = RuntimeState.lastPayload;
            if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
                this.hidePanel();
                return;
            }

            const canvas = bridge.renderer.domElement;
            if (!canvas) {
                this.hidePanel();
                return;
            }

            const rect = canvas.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                this.hidePanel();
                return;
            }

            this.state.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.state.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            this.state.raycaster.setFromCamera(this.state.pointerNdc, bridge.camera);

            const intersections = this.state.raycaster.intersectObject(RuntimeState.overlay, true);
            if (!Array.isArray(intersections) || intersections.length === 0) {
                this.hidePanel();
                return;
            }

            const hit = intersections[0];
            const hitX = Number(hit.point && hit.point.x);
            const hitY = Number(hit.point && hit.point.y);
            if (!Number.isFinite(hitX) || !Number.isFinite(hitY)) {
                this.hidePanel();
                return;
            }

            const nearestDepth = this.findNearestDepthPoint(payload.points, hitX, hitY);
            if (!nearestDepth || !Array.isArray(nearestDepth.point)) {
                this.hidePanel();
                return;
            }

            const velocityEstimation = this.estimateVelocityByFaces(payload.velocity_faces, hitX, hitY);
            this.setPanelText("xy", `${this.formatNumber(hitX, 2)}, ${this.formatNumber(hitY, 2)}`);
            const depthValue = Number(nearestDepth.point[4]);
            this.setPanelText("depth", Number.isFinite(depthValue) ? this.formatNumber(depthValue, 3, " m") : "--");

            if (velocityEstimation) {
                this.setPanelText("velocity", this.formatNumber(velocityEstimation.estimatedVelocity, 3, " m/s"));
            } else {
                this.setPanelText("velocity", "--");
            }

            this.showPanelAt(event.clientX, event.clientY);
        },

        bind(bridge) {
            if (this.state.isBound || !bridge || !bridge.renderer || !bridge.camera) {
                return;
            }
            const canvas = bridge.renderer.domElement;
            if (!canvas) {
                return;
            }
            this.ensurePanel();
            this.state.raycaster.params.Points.threshold = 9;
            canvas.addEventListener("click", (event) => {
                this.handleCanvasClick(event);
            });
            this.state.isBound = true;
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
         * 主要功能: 根据深度比例（t在[0,1]之间）从定义的颜色渐变中采样对应的 RGB 颜色。
         * 输入参数:
         *   - t: 归一化深度值 (number, 0~1)
         * 输出: [r, g, b] 归一化颜色数组 (array)
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
         * 主要功能: 将离散的水深点数据处理成平滑的网格几何体。包括边界计算、网格化、空洞填充和拉普拉斯平滑。
         * 输入参数:
         *   - points: 原始点数据数组 [[x,y,bed,water,depth], ...] (array)
         *   - centerX/centerY: 兼容性中心坐标 (number)
         * 输出: 包含 BufferGeometry 和元数据的对象，若失败则返回 null (object|null)
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
            const isHighDensity = points.length >= SURFACE_HIGH_DENSITY_POINT_THRESHOLD;
            const gridMax = isHighDensity ? SURFACE_GRID_MAX_HIGH_DENSITY : SURFACE_GRID_MAX;
            const holeFillPasses = isHighDensity ? Math.max(2, SURFACE_HOLE_FILL_PASSES - 3) : SURFACE_HOLE_FILL_PASSES;
            const smoothPasses = isHighDensity ? Math.max(1, SURFACE_SMOOTH_PASSES - 1) : SURFACE_SMOOTH_PASSES;
            const baseGrid = THREE.MathUtils.clamp(
                Math.round(Math.sqrt(points.length) * (isHighDensity ? 0.6 : 0.72)),
                SURFACE_GRID_MIN,
                gridMax,
            );
            const gridCols = baseGrid;
            const gridRows = THREE.MathUtils.clamp(
                Math.round(baseGrid * aspect),
                SURFACE_GRID_MIN,
                gridMax,
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

            for (let pass = 0; pass < holeFillPasses; pass += 1) {
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

            for (let pass = 0; pass < smoothPasses; pass += 1) {
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
                    // Accept per-triangle validity to avoid dropping the whole quad when only one corner is missing.
                    if (validGrid[i00] && validGrid[i01] && validGrid[i11]) {
                        indices.push(i00, i01, i11);
                    }
                    if (validGrid[i00] && validGrid[i11] && validGrid[i10]) {
                        indices.push(i00, i11, i10);
                    }
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
         * 主要功能: 备用方案，将点数据直接转换为带颜色顶点的点云几何体。
         * 输入参数:
         *   - points: 原始点数据数组 (array)
         *   - centerX/centerY: 兼容性中心坐标 (number)
         * 输出: 包含 BufferGeometry 和元数据的对象，若失败则返回 null (object|null)
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
         * 主要功能: 根据当前渲染模式更新或创建水深叠加层（Mesh 或 Points）。维护一个调试用的球体位置。
         * 输入参数:
         *   - bridge: 包含场景实例的 bridge 对象 (object)
         *   - payload: 包含水深点数据的载荷 (object)
         * 输出: 无 (直接操作场景对象)
         */
        createOrUpdateWaterDepthOverlay(bridge, payload) {
            const renderStartAt = performance.now();
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
                    const meshMaterial = new THREE.MeshLambertMaterial({
                        vertexColors: true,
                        transparent: true,
                        opacity: 0.9,
                        side: THREE.DoubleSide,
                    });
                    overlay = new THREE.Mesh(prepared.geometry, meshMaterial);
                }
                overlay.name = "hdfWaterDepthOverlay";
                overlay.renderOrder = 999;
                overlay.frustumCulled = true;
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

            setPerfText(perfDom.frontendRender, formatMs(performance.now() - renderStartAt));
            setPerfText(perfDom.stage, "HDF render");
        },
    };

    /**
     * RuntimeModule
     * Function: Coordinate events, async frame loading, and app startup.
     * Key variables: RuntimeState request guard and selected timeline index.
     * Flow: bootstrap -> bind listeners -> fetch frame -> render overlay.
     */
    const RuntimeModule = {
        prefetchAhead(payload) {
            if (!payload || !RuntimeState.projectId) {
                return;
            }
            const nowIndex = Number(payload.time_index);
            const timeStepCount = Number(payload.time_step_count);
            if (!Number.isFinite(nowIndex) || !Number.isFinite(timeStepCount) || timeStepCount <= 0) {
                return;
            }

            for (let offset = 1; offset <= HDF_PREFETCH_AHEAD_COUNT; offset += 1) {
                const nextIndex = Math.trunc(nowIndex) + offset;
                if (nextIndex >= timeStepCount) {
                    break;
                }
                DataModule.prefetchWaterDepthPayload(RuntimeState.projectId, nextIndex);
            }
        },

        stopPlayback() {
            if (RuntimeState.playbackTimerId) {
                window.clearTimeout(RuntimeState.playbackTimerId);
            }
            RuntimeState.playbackTimerId = 0;
            RuntimeState.isPlaying = false;
            TimelineModule.createOrUpdateUi(TimelineModule.state.timeStepCount, TimelineModule.state.selectedTimeIndex);
        },

        startPlayback() {
            const maxIndex = Math.max(0, Math.trunc(TimelineModule.state.timeStepCount) - 1);
            const currentIndex = THREE.MathUtils.clamp(Math.trunc(TimelineModule.state.selectedTimeIndex), 0, maxIndex);
            if (RuntimeState.isPlaying || currentIndex >= maxIndex) {
                return;
            }
            RuntimeState.isPlaying = true;
            TimelineModule.createOrUpdateUi(TimelineModule.state.timeStepCount, TimelineModule.state.selectedTimeIndex);
            this.prefetchAhead(RuntimeState.lastPayload);

            const tick = async () => {
                if (!RuntimeState.isPlaying) {
                    return;
                }
                const tickStartAt = performance.now();
                const latestMax = Math.max(0, Math.trunc(TimelineModule.state.timeStepCount) - 1);
                const latestCurrent = THREE.MathUtils.clamp(Math.trunc(TimelineModule.state.selectedTimeIndex), 0, latestMax);
                if (latestCurrent >= latestMax) {
                    this.stopPlayback();
                    return;
                }
                await this.loadAndRenderTimeIndex(latestCurrent + 1);
                if (!RuntimeState.isPlaying) {
                    return;
                }
                const afterMax = Math.max(0, Math.trunc(TimelineModule.state.timeStepCount) - 1);
                const afterCurrent = THREE.MathUtils.clamp(Math.trunc(TimelineModule.state.selectedTimeIndex), 0, afterMax);
                if (afterCurrent >= afterMax) {
                    this.stopPlayback();
                    return;
                }
                const tickElapsedMs = performance.now() - tickStartAt;
                const nextDelayMs = Math.max(0, RuntimeState.playbackIntervalMs - tickElapsedMs);
                RuntimeState.playbackTimerId = window.setTimeout(() => {
                    void tick();
                }, nextDelayMs);
            };

            RuntimeState.playbackTimerId = window.setTimeout(() => {
                void tick();
            }, 0);
        },

        /**
         * setRenderMode
         * 主要功能: 规范化并应用渲染模式（auto/surface/points）。
         * 输入参数:
         *   - mode: 模式候选字符串 (string)
         * 输出: 模式是否发生改变 (boolean)
         */
        setRenderMode(mode) {
            const normalized = String(mode || "").toLowerCase();
            const nextMode = (normalized === RENDER_MODE_AUTO || normalized === RENDER_MODE_SURFACE || normalized === RENDER_MODE_POINTS)
                ? normalized
                : RENDER_MODE_POINTS;

            if (RuntimeState.renderMode === nextMode) {
                return false;
            }
            RuntimeState.renderMode = nextMode;
            return true;
        },

        /**
         * loadAndRenderTimeIndex
         * 主要功能: 异步加载指定时间索引的 HDF 水深帧，并通过诊断、UI 同步和叠加层更新流程进行处理。包含竞态检查。
         * 输入参数:
         *   - timeIndex: 时间步索引，-1 表示由后端决定默认帧 (number)
         * 异步顺序: 异步 Fetch -> 检查 requestId 是否过时 -> 同步渲染。
         * 输出: Promise<void>
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

                if (HDF_VERBOSE_FRAME_LOG || !RuntimeState.isPlaying) {
                    DataModule.logPointSample(payload);
                    DiagnosticsModule.logSummary(payload);
                }
                RuntimeState.lastPayload = payload;
                this.prefetchAhead(payload);
                TimelineModule.createOrUpdateUi(payload.time_step_count, payload.time_index);
                if (RuntimeState.isPlaying && payload.time_index >= payload.time_step_count - 1) {
                    this.stopPlayback();
                }

                if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
                    return;
                }

                OverlayModule.createOrUpdateWaterDepthOverlay(RuntimeState.bridge, payload);
            } catch (error) {
                void error;
                if (RuntimeState.isPlaying) {
                    this.stopPlayback();
                }
            } finally {
                RuntimeState.isLoading = false;
            }
        },

        /**
         * bindTimelineEvent
         * 主要功能: 订阅时间轴选择事件并触发对应的帧加载逻辑。
         * 输入/输出: 无
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
         * 主要功能: 订阅渲染模式切换事件并触发当前帧的重新渲染。
         * 输入/输出: 无
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

        bindPlaybackEvent() {
            window.addEventListener("hdf-play-request", () => {
                this.startPlayback();
            });
            window.addEventListener("hdf-pause-request", () => {
                this.stopPlayback();
            });
        },

        async writeXnXlsxSnapshot() {
            if (!RuntimeState.projectId) {
                return;
            }
            RuntimeState.autoWriteInFlight = true;
            if (exportDom.button) {
                exportDom.button.disabled = true;
                exportDom.button.style.opacity = "0.45";
                exportDom.button.style.cursor = "not-allowed";
            }
            if (exportDom.status) {
                exportDom.status.textContent = "写入中...";
            }
            const payload = RuntimeState.lastPayload && typeof RuntimeState.lastPayload === "object" ? RuntimeState.lastPayload : {};
            const requestBody = {
                project_id: Number(RuntimeState.projectId),
                time_index: payload.time_index ?? TimelineModule.state.selectedTimeIndex,
                time_step_count: payload.time_step_count ?? TimelineModule.state.timeStepCount,
                point_count: payload.point_count ?? null,
                render_mode: RuntimeState.renderMode,
                cache_mode: RuntimeState.cacheMode,
                playback_state: RuntimeState.isPlaying ? "playing" : "paused",
                metrics: {
                    data_gen_ms: parseNumericText(perfDom.dataGen && perfDom.dataGen.textContent),
                    backend_transfer_ms: parseNumericText(perfDom.backendTransfer && perfDom.backendTransfer.textContent),
                    frontend_fetch_ms: parseNumericText(perfDom.frontendFetch && perfDom.frontendFetch.textContent),
                    frontend_parse_ms: parseNumericText(perfDom.frontendParse && perfDom.frontendParse.textContent),
                    frontend_render_ms: parseNumericText(perfDom.frontendRender && perfDom.frontendRender.textContent),
                    tti_ms: parseNumericText(perfDom.tti && perfDom.tti.textContent),
                    tti_init_ms: parseNumericText(perfDom.ttiInit && perfDom.ttiInit.textContent),
                    tti_project_ms: parseNumericText(perfDom.ttiProject && perfDom.ttiProject.textContent),
                    tti_meta_ms: parseNumericText(perfDom.ttiMeta && perfDom.ttiMeta.textContent),
                    tti_tiles_ms: parseNumericText(perfDom.ttiTiles && perfDom.ttiTiles.textContent),
                    tti_rebuild_ms: parseNumericText(perfDom.ttiRebuild && perfDom.ttiRebuild.textContent),
                    realtime_fps: parseNumericText(perfDom.realtimeFps && perfDom.realtimeFps.textContent),
                    draw_calls: parseNumericText(perfDom.drawCalls && perfDom.drawCalls.textContent),
                    triangles: parseNumericText(perfDom.triangles && perfDom.triangles.textContent),
                    stage: perfDom.stage && perfDom.stage.textContent ? String(perfDom.stage.textContent) : "",
                },
            };
            try {
                const response = await fetch("/api/hdf/write-xn-xlsx", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body: JSON.stringify(requestBody),
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const result = await response.json();
                if (exportDom.status) {
                    exportDom.status.textContent = `已写入 ${result.path || "xn.xlsx"}`;
                }
            } catch (error) {
                void error;
                if (exportDom.status) {
                    exportDom.status.textContent = "写入失败";
                }
            } finally {
                RuntimeState.autoWriteInFlight = false;
                if (exportDom.button) {
                    exportDom.button.disabled = false;
                    exportDom.button.style.opacity = "1";
                    exportDom.button.style.cursor = "pointer";
                }
            }
        },

        bindAutoRecordWhenDrawCallsOne() {
            if (!perfDom.drawCalls) {
                return;
            }
            if (RuntimeState.autoWriteTimerId) {
                window.clearInterval(RuntimeState.autoWriteTimerId);
            }
            RuntimeState.autoWriteTimerId = window.setInterval(() => {
                const drawCallsValue = parseNumericText(perfDom.drawCalls && perfDom.drawCalls.textContent);
                if (!Number.isFinite(drawCallsValue)) {
                    RuntimeState.lastObservedDrawCalls = null;
                    return;
                }
                const asInt = Math.trunc(drawCallsValue);
                const now = Date.now();
                const isEdgeToTarget = RuntimeState.lastObservedDrawCalls !== AUTO_WRITE_WHEN_DRAWCALLS_EQ && asInt === AUTO_WRITE_WHEN_DRAWCALLS_EQ;
                const cooldownPassed = now - RuntimeState.lastAutoWriteAt >= AUTO_WRITE_COOLDOWN_MS;
                RuntimeState.lastObservedDrawCalls = asInt;
                if (!isEdgeToTarget || !cooldownPassed || RuntimeState.autoWriteInFlight) {
                    return;
                }
                RuntimeState.lastAutoWriteAt = now;
                if (exportDom.status) {
                    exportDom.status.textContent = "DrawCalls=1，自动写入中...";
                }
                void this.writeXnXlsxSnapshot();
            }, 900);
        },

        bindExportEvent() {
            if (!exportDom.button) {
                return;
            }
            exportDom.button.onclick = () => {
                void this.writeXnXlsxSnapshot();
            };
        },

        /**
         * bindDebugShortcuts
         * 主要功能: 调试快捷键绑定的占位函数。
         * 输入/输出: 无
         */
        bindDebugShortcuts() {
            // Intentionally kept empty.
        },

        /**
         * bootstrap
         * 主要功能: 叠加层模块的启动入口。等待主场景就绪后，初始化项目 ID、渲染模式、默认帧并绑定 UI 事件。
         * 异步顺序: 等待 baseScene -> 等待 projectId -> 异步加载第一帧。
         * 输入/输出: Promise<void>
         */
        async bootstrap() {
            const bridge = await DataModule.waitForBaseScene(8000);
            const projectId = await DataModule.resolveProjectIdWithFallback();
            this.setRenderMode(DataModule.resolveRenderModeFromUrl());
            RuntimeState.cacheMode = DataModule.resolveCacheModeFromUrl();
            RuntimeState.playbackIntervalMs = DataModule.resolvePlaybackIntervalFromUrl();
            DataModule.clearPayloadCache();
            RuntimeState.bridge = bridge;
            RuntimeState.projectId = projectId;
            InteractionModule.bind(bridge);

            this.bindExportEvent();
            this.bindAutoRecordWhenDrawCallsOne();
            this.bindDebugShortcuts();

            if (!HDF_LOAD_ENABLED) {
                if (exportDom.status) {
                    exportDom.status.textContent = "HDF已临时屏蔽；DrawCalls=1自动记录已开启";
                }
                return;
            }

            const payload = await DataModule.fetchWaterDepthPayload(projectId, HDF_INITIAL_TIME_INDEX);
            RuntimeState.lastPayload = payload;
            this.prefetchAhead(payload);
            TimelineModule.createOrUpdateUi(payload.time_step_count, payload.time_index);
            if (HDF_VERBOSE_FRAME_LOG) {
                DataModule.logPointSample(payload);
                DiagnosticsModule.logSummary(payload);
            }

            this.bindTimelineEvent();
            this.bindRenderModeEvent();
            this.bindPlaybackEvent();
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
