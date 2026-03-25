(function () {
    "use strict";

    const dom = {
        sceneRoot: document.getElementById("sceneRoot"),
        dataModeSelect: document.getElementById("dataModeSelect"),
        projectSelect: document.getElementById("projectSelect"),
        startCountInput: document.getElementById("startCountInput"),
        stepCountInput: document.getElementById("stepCountInput"),
        maxCountInput: document.getElementById("maxCountInput"),
        fpsThresholdInput: document.getElementById("fpsThresholdInput"),
        parseBuildLimitInput: document.getElementById("parseBuildLimitInput"),
        totalLimitInput: document.getElementById("totalLimitInput"),
        includeInvalidVerticesInput: document.getElementById("includeInvalidVerticesInput"),
        loadBaseBtn: document.getElementById("loadBaseBtn"),
        runAutoBtn: document.getElementById("runAutoBtn"),
        renderOnceBtn: document.getElementById("renderOnceBtn"),
        stopBtn: document.getElementById("stopBtn"),
        statPointCount: document.getElementById("statPointCount"),
        statJsonSize: document.getElementById("statJsonSize"),
        statFps: document.getElementById("statFps"),
        statCeiling: document.getElementById("statCeiling"),
        statParseMs: document.getElementById("statParseMs"),
        statBuildMs: document.getElementById("statBuildMs"),
        statRenderedPoints: document.getElementById("statRenderedPoints"),
        statDrawCalls: document.getElementById("statDrawCalls"),
        exportCsvBtn: document.getElementById("exportCsvBtn"),
        clearRecordsBtn: document.getElementById("clearRecordsBtn"),
        recordCountText: document.getElementById("recordCountText"),
        logBox: document.getElementById("logBox"),
    };

    const RUN_RECORDS_STORAGE_KEY = "baselineStressRunRecords.v2";
    const DEFAULT_PARSE_BUILD_LIMIT_MS = 5000;
    const DEFAULT_TOTAL_LIMIT_MS = 12000;

    const state = {
        scene: null,
        camera: null,
        renderer: null,
        controls: null,
        mesh: null,
        wire: null,
        fpsFrameCount: 0,
        fpsElapsed: 0,
        lastTick: performance.now(),
        currentFps: 0,
        running: false,
        runToken: 0,
        currentPointCount: 0,
        currentJsonBytes: 0,
        currentParseMs: 0,
        currentBuildMs: 0,
        lastStableCount: 0,
        lastStableBytes: 0,
        lastTriangles: 0,
        lastDrawCalls: 0,
        knownValidPointCount: 0,
        lastStride: 0,
        runRecords: [],
    };

    function safeNumber(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function loadRunRecords() {
        try {
            const raw = window.localStorage.getItem(RUN_RECORDS_STORAGE_KEY);
            if (!raw) {
                return [];
            }
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed.filter((item) => item && typeof item === "object");
        } catch (_error) {
            return [];
        }
    }

    function saveRunRecords() {
        try {
            window.localStorage.setItem(RUN_RECORDS_STORAGE_KEY, JSON.stringify(state.runRecords));
        } catch (_error) {
            logLine("警告: 无法写入本地实验记录（可能是浏览器存储限制）");
        }
    }

    function updateRecordCountUi() {
        if (dom.recordCountText) {
            dom.recordCountText.textContent = String(state.runRecords.length);
        }
    }

    function csvEscape(value) {
        const text = String(value ?? "");
        if (!/[",\n\r]/.test(text)) {
            return text;
        }
        return `"${text.replace(/"/g, '""')}"`;
    }

    function toCsvText(records) {
        const headers = [
            "record_id",
            "timestamp",
            "record_kind",
            "run_id",
            "step_index",
            "mode",
            "project_id",
            "start_count",
            "step_count",
            "max_count",
            "fps_threshold",
            "parse_build_limit_ms",
            "total_limit_ms",
            "include_invalid_vertices",
            "target_count",
            "actual_count",
            "json_bytes",
            "predicted_stride",
            "stride",
            "fps",
            "parse_ms",
            "build_ms",
            "total_ms",
            "threshold_hit",
            "threshold_reason",
            "skip_reason",
            "stable_count",
            "stable_json_bytes",
            "stop_fps",
            "stop_parse_ms",
            "stop_build_ms",
            "stop_total_ms",
            "stop_reason",
            "tested_steps",
            "skipped_steps",
            "run_duration_ms",
            "run_started_at",
            "run_finished_at",
        ];
        const lines = [headers.join(",")];
        for (let i = 0; i < records.length; i += 1) {
            const r = records[i] || {};
            const row = [
                r.record_id,
                r.timestamp,
                r.record_kind || "summary",
                r.run_id,
                r.step_index,
                r.mode,
                r.project_id,
                r.start_count,
                r.step_count,
                r.max_count,
                r.fps_threshold,
                r.parse_build_limit_ms,
                r.total_limit_ms,
                r.include_invalid_vertices,
                r.target_count,
                r.actual_count,
                r.json_bytes,
                r.predicted_stride,
                r.stride,
                Number.isFinite(Number(r.fps)) ? Number(r.fps).toFixed(2) : "",
                Number.isFinite(Number(r.parse_ms)) ? Number(r.parse_ms).toFixed(2) : "",
                Number.isFinite(Number(r.build_ms)) ? Number(r.build_ms).toFixed(2) : "",
                Number.isFinite(Number(r.total_ms)) ? Number(r.total_ms).toFixed(2) : "",
                r.threshold_hit,
                r.threshold_reason,
                r.skip_reason,
                r.stable_count,
                r.stable_json_bytes,
                Number.isFinite(Number(r.stop_fps)) ? Number(r.stop_fps).toFixed(2) : "",
                Number.isFinite(Number(r.stop_parse_ms)) ? Number(r.stop_parse_ms).toFixed(2) : "",
                Number.isFinite(Number(r.stop_build_ms)) ? Number(r.stop_build_ms).toFixed(2) : "",
                Number.isFinite(Number(r.stop_total_ms)) ? Number(r.stop_total_ms).toFixed(2) : "",
                r.stop_reason,
                r.tested_steps,
                r.skipped_steps,
                Number.isFinite(Number(r.run_duration_ms)) ? Number(r.run_duration_ms).toFixed(2) : "",
                r.run_started_at,
                r.run_finished_at,
            ].map(csvEscape);
            lines.push(row.join(","));
        }
        return `${lines.join("\n")}\n`;
    }

    function downloadCsv() {
        if (!state.runRecords.length) {
            logLine("暂无实验记录，先运行一次自动阶梯压测");
            return;
        }
        const csvText = toCsvText(state.runRecords);
        const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
        const anchor = document.createElement("a");
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
        anchor.href = URL.createObjectURL(blob);
        anchor.download = `baseline_stress_runs_${stamp}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(anchor.href);
        logLine(`CSV 已导出: ${state.runRecords.length} 条记录`);
    }

    function clearRunRecords() {
        state.runRecords = [];
        saveRunRecords();
        updateRecordCountUi();
        logLine("已清空本浏览器中的实验记录");
    }

    function appendRunRecord(payload) {
        const nextId = state.runRecords.length + 1;
        state.runRecords.push({
            record_id: nextId,
            ...payload,
        });
        saveRunRecords();
        updateRecordCountUi();
    }

    function buildRunId(mode, projectId) {
        const safeMode = String(mode || "unknown").trim() || "unknown";
        const safeProjectId = String(projectId || "unknown").trim() || "unknown";
        const randomPart = Math.random().toString(36).slice(2, 8);
        return `${safeMode}-${safeProjectId}-${Date.now()}-${randomPart}`;
    }

    const ELEVATION_COLOR_GRADIENT = [
        { t: 0.0, color: [18, 42, 120] },
        { t: 0.2, color: [18, 110, 95] },
        { t: 0.7, color: [255, 235, 59] },
        { t: 1.0, color: [245, 130, 130] },
    ];

    function logLine(text) {
        const line = `[${new Date().toLocaleTimeString()}] ${text}`;
        if (!dom.logBox) {
            return;
        }
        dom.logBox.textContent = `${line}\n${dom.logBox.textContent}`.slice(0, 9000);
    }

    function clampInt(value, fallback, minValue, maxValue) {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            return fallback;
        }
        const t = Math.trunc(n);
        return Math.max(minValue, Math.min(maxValue, t));
    }

    function toErrorText(error) {
        if (error && typeof error.message === "string" && error.message.trim()) {
            return error.message;
        }
        if (typeof error === "string" && error.trim()) {
            return error;
        }
        try {
            return JSON.stringify(error);
        } catch (_ignored) {
            return String(error || "unknown error");
        }
    }

    function getIncludeInvalidVertices() {
        if (!dom.includeInvalidVerticesInput) {
            return true;
        }
        return Boolean(dom.includeInvalidVerticesInput.checked);
    }

    function getRunThresholdConfig() {
        return {
            parseBuildLimitMs: clampInt(dom.parseBuildLimitInput?.value, DEFAULT_PARSE_BUILD_LIMIT_MS, 100, 60000),
            totalLimitMs: clampInt(dom.totalLimitInput?.value, DEFAULT_TOTAL_LIMIT_MS, 500, 120000),
        };
    }

    function getDataMode() {
        const value = String(dom.dataModeSelect?.value || "synthetic").trim().toLowerCase();
        return value === "tif" ? "tif" : "synthetic";
    }

    function applyModeUi() {
        const mode = getDataMode();
        if (dom.projectSelect) {
            dom.projectSelect.disabled = mode !== "tif";
        }
    }

    function formatBytes(bytes) {
        const n = Number(bytes);
        if (!Number.isFinite(n) || n <= 0) {
            return "--";
        }
        if (n >= 1024 * 1024 * 1024) {
            return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        }
        if (n >= 1024 * 1024) {
            return `${(n / (1024 * 1024)).toFixed(2)} MB`;
        }
        if (n >= 1024) {
            return `${(n / 1024).toFixed(1)} KB`;
        }
        return `${Math.trunc(n)} B`;
    }

    function updateStats() {
        if (dom.statPointCount) {
            dom.statPointCount.textContent = state.currentPointCount > 0 ? String(state.currentPointCount) : "--";
        }
        if (dom.statJsonSize) {
            dom.statJsonSize.textContent = formatBytes(state.currentJsonBytes);
        }
        if (dom.statFps) {
            dom.statFps.textContent = state.currentFps > 0 ? state.currentFps.toFixed(1) : "--";
        }
        if (dom.statCeiling) {
            if (state.lastStableCount > 0 && state.lastStableBytes > 0) {
                dom.statCeiling.textContent = `${state.lastStableCount} / ${formatBytes(state.lastStableBytes)}`;
            } else {
                dom.statCeiling.textContent = "--";
            }
        }
        if (dom.statParseMs) {
            dom.statParseMs.textContent = state.currentParseMs > 0 ? `${state.currentParseMs.toFixed(1)} ms` : "--";
        }
        if (dom.statBuildMs) {
            dom.statBuildMs.textContent = state.currentBuildMs > 0 ? `${state.currentBuildMs.toFixed(1)} ms` : "--";
        }
        if (dom.statRenderedPoints) {
            dom.statRenderedPoints.textContent = state.lastTriangles > 0 ? String(state.lastTriangles) : "--";
        }
        if (dom.statDrawCalls) {
            dom.statDrawCalls.textContent = state.lastDrawCalls > 0 ? String(state.lastDrawCalls) : "--";
        }
    }

    function sampleElevationRamp(t) {
        if (t <= ELEVATION_COLOR_GRADIENT[0].t) {
            return ELEVATION_COLOR_GRADIENT[0].color.map((value) => value / 255);
        }

        for (let i = 0; i < ELEVATION_COLOR_GRADIENT.length - 1; i += 1) {
            const left = ELEVATION_COLOR_GRADIENT[i];
            const right = ELEVATION_COLOR_GRADIENT[i + 1];
            if (t < left.t || t > right.t) {
                continue;
            }
            const localT = (t - left.t) / Math.max(right.t - left.t, 1e-9);
            return [
                (left.color[0] + (right.color[0] - left.color[0]) * localT) / 255,
                (left.color[1] + (right.color[1] - left.color[1]) * localT) / 255,
                (left.color[2] + (right.color[2] - left.color[2]) * localT) / 255,
            ];
        }

        return ELEVATION_COLOR_GRADIENT[ELEVATION_COLOR_GRADIENT.length - 1].color.map((value) => value / 255);
    }

    function disposeRenderObjects() {
        if (state.mesh) {
            state.mesh.geometry.dispose();
            state.mesh.material.dispose();
            state.scene.remove(state.mesh);
            state.mesh = null;
        }
        if (state.wire) {
            state.wire.geometry.dispose();
            state.wire.material.dispose();
            state.scene.remove(state.wire);
            state.wire = null;
        }
    }

    function fitCameraByBounds(bounds) {
        const center = new THREE.Vector3(
            (bounds.minX + bounds.maxX) * 0.5,
            (bounds.minY + bounds.maxY) * 0.5,
            (bounds.minZ + bounds.maxZ) * 0.5,
        );
        const size = new THREE.Vector3(
            bounds.maxX - bounds.minX,
            bounds.maxY - bounds.minY,
            bounds.maxZ - bounds.minZ,
        );
        const maxDim = Math.max(size.x, size.y, size.z, 1);

        state.camera.near = Math.max(0.1, maxDim / 20000);
        state.camera.far = maxDim * 70;
        state.camera.position.set(center.x, center.y - maxDim * 1.8, center.z + maxDim * 1.05);
        state.controls.target.copy(center);
        state.camera.updateProjectionMatrix();
        state.controls.update();
    }

    function buildSurfaceAndWire(payload) {
        const vertices = Array.isArray(payload?.vertices) ? payload.vertices : [];
        if (!vertices.length) {
            throw new Error("JSON 顶点为空，无法构建色带和折线");
        }

        const keyToIndex = new Map();
        const positions = [];
        const zValues = [];
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;

        for (let i = 0; i < vertices.length; i += 1) {
            const item = vertices[i];
            if (!item || !item.valid) {
                continue;
            }
            const row = Number(item.sample_row);
            const col = Number(item.sample_col);
            const x = Number(item.x);
            const y = Number(item.y);
            const z = Number(item.elevation);
            if (!Number.isFinite(row) || !Number.isFinite(col) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                continue;
            }

            const key = `${row}_${col}`;
            if (keyToIndex.has(key)) {
                continue;
            }

            keyToIndex.set(key, positions.length / 3);
            positions.push(x, y, z);
            zValues.push(z);

            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            maxZ = Math.max(maxZ, z);
        }

        if (!positions.length) {
            throw new Error("JSON 中无有效高程点");
        }

        const sampleStride = Math.max(1, Math.trunc(Number(payload?.grid?.sample_stride) || 1));
        const rowStep = sampleStride;
        const colStep = sampleStride;

        const triangles = [];
        const wireSegments = [];
        const uniqueEdges = new Set();

        const pushEdge = (a, b) => {
            if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
                return;
            }
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            const key = `${lo}_${hi}`;
            if (uniqueEdges.has(key)) {
                return;
            }
            uniqueEdges.add(key);
            wireSegments.push(a, b);
        };

        for (const key of keyToIndex.keys()) {
            const split = key.split("_");
            if (split.length !== 2) {
                continue;
            }
            const row = Number(split[0]);
            const col = Number(split[1]);
            if (!Number.isFinite(row) || !Number.isFinite(col)) {
                continue;
            }

            const i00 = keyToIndex.get(`${row}_${col}`);
            const i01 = keyToIndex.get(`${row}_${col + colStep}`);
            const i10 = keyToIndex.get(`${row + rowStep}_${col}`);
            const i11 = keyToIndex.get(`${row + rowStep}_${col + colStep}`);

            if (i00 == null || i01 == null || i10 == null || i11 == null) {
                continue;
            }

            triangles.push(i00, i01, i11);
            triangles.push(i00, i11, i10);
        }

        if (!triangles.length) {
            throw new Error("网格三角形为空，无法渲染色带");
        }

        for (let i = 0; i < triangles.length; i += 3) {
            const a = triangles[i];
            const b = triangles[i + 1];
            const c = triangles[i + 2];
            pushEdge(a, b);
            pushEdge(b, c);
            pushEdge(c, a);
        }

        const zRange = Math.max(maxZ - minZ, 1e-9);
        const colors = new Float32Array((positions.length / 3) * 3);
        for (let i = 0; i < zValues.length; i += 1) {
            const t = THREE.MathUtils.clamp((zValues[i] - minZ) / zRange, 0, 1);
            const [r, g, b] = sampleElevationRamp(t);
            colors[i * 3] = r;
            colors[i * 3 + 1] = g;
            colors[i * 3 + 2] = b;
        }

        const meshGeometry = new THREE.BufferGeometry();
        meshGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        meshGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        meshGeometry.setIndex(triangles);
        meshGeometry.computeVertexNormals();

        const meshMaterial = new THREE.MeshLambertMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.86,
            flatShading: true,
        });

        const wirePositions = new Float32Array(wireSegments.length * 3);
        for (let i = 0; i < wireSegments.length; i += 1) {
            const srcIndex = wireSegments[i] * 3;
            const dstIndex = i * 3;
            wirePositions[dstIndex] = positions[srcIndex];
            wirePositions[dstIndex + 1] = positions[srcIndex + 1];
            wirePositions[dstIndex + 2] = positions[srcIndex + 2];
        }

        const wireGeometry = new THREE.BufferGeometry();
        wireGeometry.setAttribute("position", new THREE.BufferAttribute(wirePositions, 3));
        const wireMaterial = new THREE.LineBasicMaterial({
            color: 0x4ad4ff,
            transparent: true,
            opacity: 0.44,
        });

        return {
            mesh: new THREE.Mesh(meshGeometry, meshMaterial),
            wire: new THREE.LineSegments(wireGeometry, wireMaterial),
            pointCount: positions.length / 3,
            triangleCount: triangles.length / 3,
            bounds: { minX, minY, minZ, maxX, maxY, maxZ },
        };
    }

    async function fetchStressPayload(projectId, targetPoints, includeInvalidVertices) {
        const mode = getDataMode();
        const includeFlag = includeInvalidVertices ? "true" : "false";
        const url = mode === "tif"
            ? `/api/projects/${encodeURIComponent(projectId)}/tif-stress-json?target_points=${encodeURIComponent(targetPoints)}&include_invalid_vertices=${includeFlag}`
            : `/api/stress/synthetic-grid-json?target_points=${encodeURIComponent(targetPoints)}&include_invalid_vertices=${includeFlag}`;
        const fetchStart = performance.now();
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        const fetchEnd = performance.now();
        if (!response.ok) {
            throw new Error(`加载压力 JSON 失败: HTTP ${response.status}`);
        }

        const text = await response.text();
        const jsonBytes = new TextEncoder().encode(text).length;
        const parseStart = performance.now();
        const payload = JSON.parse(text);
        const parseEnd = performance.now();

        return {
            payload,
            jsonBytes,
            fetchMs: fetchEnd - fetchStart,
            parseMs: parseEnd - parseStart,
            mode,
        };
    }

    async function loadAndRender(targetPoints, includeInvalidVertices = true) {
        const mode = getDataMode();
        const projectId = String(dom.projectSelect.value || "").trim();
        if (mode === "tif" && !projectId) {
            throw new Error("没有可用项目");
        }

        const request = await fetchStressPayload(projectId, targetPoints, includeInvalidVertices);
        const buildStart = performance.now();
        const renderData = buildSurfaceAndWire(request.payload);
        const buildEnd = performance.now();

        disposeRenderObjects();
        state.mesh = renderData.mesh;
        state.wire = renderData.wire;
        state.scene.add(state.mesh);
        state.scene.add(state.wire);
        fitCameraByBounds(renderData.bounds);

        state.currentPointCount = renderData.pointCount;
        state.currentJsonBytes = request.jsonBytes;
        state.currentParseMs = request.parseMs;
        state.currentBuildMs = buildEnd - buildStart;
        state.knownValidPointCount = Number(request.payload?.metadata?.valid_point_count) || state.knownValidPointCount;
        state.lastStride = Number(request.payload?.stride) || 0;
        updateStats();

        logLine(
            [
                `target=${targetPoints}`,
                `actual=${renderData.pointCount}`,
                `json=${formatBytes(request.jsonBytes)}`,
                `fetch=${request.fetchMs.toFixed(1)}ms`,
                `parse=${request.parseMs.toFixed(1)}ms`,
                `build=${state.currentBuildMs.toFixed(1)}ms`,
                `stride=${state.lastStride || "?"}`,
                `source=${request.mode}`,
            ].join(", "),
        );

        return {
            stride: state.lastStride,
            pointCount: renderData.pointCount,
            jsonBytes: request.jsonBytes,
        };
    }

    function estimateStrideByTarget(targetPoints) {
        const validCount = Number(state.knownValidPointCount);
        if (!Number.isFinite(validCount) || validCount <= 0) {
            return 0;
        }
        return Math.max(1, Math.ceil(Math.sqrt(validCount / Math.max(targetPoints, 1))));
    }

    async function autoRun() {
        const startCount = clampInt(dom.startCountInput.value, 2000000, 10000, 10000000);
        const stepCount = clampInt(dom.stepCountInput.value, 1000000, 5000, 5000000);
        const maxCount = clampInt(dom.maxCountInput.value, 10000000, 10000, 10000000);
        const fpsThreshold = clampInt(dom.fpsThresholdInput.value, 20, 1, 240);
        const includeInvalidVertices = getIncludeInvalidVertices();
        const thresholdConfig = getRunThresholdConfig();
        const mode = getDataMode();
        const projectId = mode === "tif" ? String(dom.projectSelect.value || "") : "synthetic";
        const runStartedAt = performance.now();
        const runStartedIso = new Date().toISOString();
        const runId = buildRunId(mode, projectId);

        state.running = true;
        state.runToken += 1;
        const token = state.runToken;

        state.lastStableCount = 0;
        state.lastStableBytes = 0;

        let stopReason = "";
        let testedSteps = 0;
        let skippedSteps = 0;
        let prevPredictedStride = 0;
        let stopFps = 0;
        let stopParseMs = 0;
        let stopBuildMs = 0;
        let stopTotalMs = 0;
        let loopIndex = 0;

        logLine(`开始自动压测: start=${startCount}, step=${stepCount}, max=${maxCount}, fpsFloor=${fpsThreshold}, parse/build阈值=${thresholdConfig.parseBuildLimitMs}ms, total阈值=${thresholdConfig.totalLimitMs}ms, includeInvalid=${includeInvalidVertices ? "1" : "0"}`);

        for (let target = startCount; target <= maxCount; target += stepCount) {
            loopIndex += 1;
            if (!state.running || token !== state.runToken) {
                stopReason = "手动停止";
                break;
            }

            const predictedStride = estimateStrideByTarget(target);
            if (mode === "tif" && predictedStride > 0 && prevPredictedStride > 0 && predictedStride === prevPredictedStride) {
                skippedSteps += 1;
                if (state.lastStableCount > 0 && state.lastStableBytes > 0) {
                    state.lastStableCount = state.currentPointCount;
                    state.lastStableBytes = state.currentJsonBytes;
                    updateStats();
                }
                logLine(`跳过重复档位: target=${target}, stride=${predictedStride}（与上一档一致）`);
                appendRunRecord({
                    timestamp: new Date().toISOString(),
                    record_kind: "skip",
                    run_id: runId,
                    step_index: loopIndex,
                    mode,
                    project_id: projectId,
                    start_count: startCount,
                    step_count: stepCount,
                    max_count: maxCount,
                    fps_threshold: fpsThreshold,
                    parse_build_limit_ms: thresholdConfig.parseBuildLimitMs,
                    total_limit_ms: thresholdConfig.totalLimitMs,
                    include_invalid_vertices: includeInvalidVertices ? "1" : "0",
                    target_count: target,
                    predicted_stride: predictedStride,
                    skip_reason: `重复 stride=${predictedStride}`,
                    run_started_at: runStartedIso,
                });
                continue;
            }

            const stepStart = performance.now();
            const rendered = await loadAndRender(target, includeInvalidVertices);
            testedSteps += 1;
            prevPredictedStride = rendered.stride || predictedStride || prevPredictedStride;
            await new Promise((resolve) => window.setTimeout(resolve, 1200));
            const stepCostMs = performance.now() - stepStart;
            const fpsNow = state.currentFps;

            logLine(`判定: target=${target}, fps=${fpsNow.toFixed(1)}, total=${stepCostMs.toFixed(1)}ms`);

            const tooSlow = fpsNow < fpsThreshold;
            const tooHeavy = state.currentParseMs > thresholdConfig.parseBuildLimitMs
                || state.currentBuildMs > thresholdConfig.parseBuildLimitMs
                || stepCostMs > thresholdConfig.totalLimitMs;
            const thresholdReasonParts = [];
            if (tooSlow) {
                thresholdReasonParts.push(`fps ${fpsNow.toFixed(1)} < ${fpsThreshold}`);
            }
            if (tooHeavy) {
                thresholdReasonParts.push("解析/建模/总耗时过高");
            }
            const thresholdReason = thresholdReasonParts.join(" + ");

            appendRunRecord({
                timestamp: new Date().toISOString(),
                record_kind: "step",
                run_id: runId,
                step_index: loopIndex,
                mode,
                project_id: projectId,
                start_count: startCount,
                step_count: stepCount,
                max_count: maxCount,
                fps_threshold: fpsThreshold,
                parse_build_limit_ms: thresholdConfig.parseBuildLimitMs,
                total_limit_ms: thresholdConfig.totalLimitMs,
                include_invalid_vertices: includeInvalidVertices ? "1" : "0",
                target_count: target,
                actual_count: Number(rendered.pointCount) || 0,
                json_bytes: Number(rendered.jsonBytes) || 0,
                predicted_stride: predictedStride,
                stride: Number(rendered.stride) || 0,
                fps: safeNumber(fpsNow),
                parse_ms: safeNumber(state.currentParseMs),
                build_ms: safeNumber(state.currentBuildMs),
                total_ms: safeNumber(stepCostMs),
                threshold_hit: tooSlow || tooHeavy ? "1" : "0",
                threshold_reason: thresholdReason,
                run_started_at: runStartedIso,
            });

            if (tooSlow || tooHeavy) {
                stopReason = `达到阈值: ${thresholdReason}`;
                stopFps = fpsNow;
                stopParseMs = state.currentParseMs;
                stopBuildMs = state.currentBuildMs;
                stopTotalMs = stepCostMs;
                break;
            }

            state.lastStableCount = state.currentPointCount;
            state.lastStableBytes = state.currentJsonBytes;
            updateStats();
        }

        state.running = false;
        updateStats();

        if (!stopReason) {
            stopReason = `已到最大目标点数: ${maxCount}`;
        }
        const stableText = state.lastStableCount > 0 && state.lastStableBytes > 0
            ? `${state.lastStableCount} / ${formatBytes(state.lastStableBytes)}`
            : "--";
        logLine(`压测结束: ${stopReason}; source=${mode}; 有效渲染步数=${testedSteps}, 跳过重复步数=${skippedSteps}, 稳定上限=${stableText}`);
        const runFinishedIso = new Date().toISOString();

        appendRunRecord({
            timestamp: runFinishedIso,
            record_kind: "summary",
            run_id: runId,
            mode,
            project_id: projectId,
            start_count: startCount,
            step_count: stepCount,
            max_count: maxCount,
            fps_threshold: fpsThreshold,
            parse_build_limit_ms: thresholdConfig.parseBuildLimitMs,
            total_limit_ms: thresholdConfig.totalLimitMs,
            include_invalid_vertices: includeInvalidVertices ? "1" : "0",
            stable_count: Number(state.lastStableCount) || 0,
            stable_json_bytes: Number(state.lastStableBytes) || 0,
            stop_fps: safeNumber(stopFps),
            stop_parse_ms: safeNumber(stopParseMs),
            stop_build_ms: safeNumber(stopBuildMs),
            stop_total_ms: safeNumber(stopTotalMs),
            stop_reason: stopReason,
            tested_steps: testedSteps,
            skipped_steps: skippedSteps,
            run_duration_ms: performance.now() - runStartedAt,
            run_started_at: runStartedIso,
            run_finished_at: runFinishedIso,
        });
    }

    function stopRun() {
        state.running = false;
        state.runToken += 1;
    }

    function animate() {
        requestAnimationFrame(animate);

        state.renderer.info.reset();

        const now = performance.now();
        const dt = now - state.lastTick;
        state.lastTick = now;

        state.fpsElapsed += dt;
        state.fpsFrameCount += 1;
        if (state.fpsElapsed >= 500) {
            state.currentFps = (state.fpsFrameCount * 1000) / Math.max(state.fpsElapsed, 1);
            state.fpsElapsed = 0;
            state.fpsFrameCount = 0;
            updateStats();
        }

        state.controls.update();
        state.renderer.render(state.scene, state.camera);
        state.lastTriangles = Number(state.renderer.info.render.triangles) || 0;
        state.lastDrawCalls = Number(state.renderer.info.render.calls) || 0;
    }

    function initScene() {
        state.scene = new THREE.Scene();
        state.scene.background = new THREE.Color(0x030812);

        state.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200000);
        state.camera.position.set(0, -100, 65);

        state.renderer = new THREE.WebGLRenderer({ antialias: true });
        state.renderer.setPixelRatio(window.devicePixelRatio || 1);
        state.renderer.setSize(window.innerWidth, window.innerHeight);
        dom.sceneRoot.appendChild(state.renderer.domElement);

        state.controls = new THREE.OrbitControls(state.camera, state.renderer.domElement);
        state.controls.enableDamping = true;
        state.controls.dampingFactor = 0.12;
        state.controls.screenSpacePanning = true;

        state.scene.add(new THREE.AmbientLight(0xffffff, 0.62));
        const dir = new THREE.DirectionalLight(0xffffff, 0.5);
        dir.position.set(120, 60, 160);
        state.scene.add(dir);

        window.addEventListener("resize", () => {
            state.camera.aspect = window.innerWidth / window.innerHeight;
            state.camera.updateProjectionMatrix();
            state.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    async function fetchCards() {
        const response = await fetch("/api/projects/cards", { headers: { Accept: "application/json" } });
        if (!response.ok) {
            throw new Error(`加载项目失败: HTTP ${response.status}`);
        }
        return response.json();
    }

    async function initProjects() {
        const cards = await fetchCards();
        const list = Array.isArray(cards) ? cards : [];
        dom.projectSelect.innerHTML = "";

        for (let i = 0; i < list.length; i += 1) {
            const item = list[i];
            const option = document.createElement("option");
            option.value = String(item.id);
            option.textContent = `${item.id} - ${item.name}`;
            dom.projectSelect.appendChild(option);
        }

        if (!list.length && getDataMode() === "tif") {
            throw new Error("数据库没有项目，无法进行压测");
        }
    }

    async function bootstrap() {
        state.runRecords = loadRunRecords();
        updateRecordCountUi();

        initScene();
        await initProjects();
        applyModeUi();

        if (dom.dataModeSelect) {
            dom.dataModeSelect.addEventListener("change", () => {
                applyModeUi();
                logLine(`已切换数据源: ${getDataMode() === "tif" ? "项目 TIF" : "合成 JSON"}`);
            });
        }

        dom.loadBaseBtn.addEventListener("click", () => {
            const target = clampInt(dom.startCountInput.value, 2000000, 10000, 10000000);
            loadAndRender(target, getIncludeInvalidVertices()).catch((error) => {
                logLine(`错误: ${toErrorText(error)}`);
            });
        });

        dom.renderOnceBtn.addEventListener("click", () => {
            const target = clampInt(dom.startCountInput.value, 2000000, 10000, 10000000);
            loadAndRender(target, getIncludeInvalidVertices()).catch((error) => {
                logLine(`错误: ${toErrorText(error)}`);
            });
        });

        dom.runAutoBtn.addEventListener("click", () => {
            if (state.running) {
                logLine("自动压测已在运行中，请先停止再重启");
                return;
            }
            autoRun().catch((error) => {
                logLine(`错误: ${toErrorText(error)}`);
            });
        });

        dom.stopBtn.addEventListener("click", () => {
            stopRun();
            logLine("已停止自动压测");
        });

        if (dom.exportCsvBtn) {
            dom.exportCsvBtn.addEventListener("click", () => {
                downloadCsv();
            });
        }

        if (dom.clearRecordsBtn) {
            dom.clearRecordsBtn.addEventListener("click", () => {
                clearRunRecords();
            });
        }

        animate();
        logLine("压测页已就绪：按你的原始方案测试单包 JSON（色带+折线）的卡顿阈值。");
    }

    bootstrap().catch((error) => {
        logLine(`初始化失败: ${error.message}`);
    });
})();
