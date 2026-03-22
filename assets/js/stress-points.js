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
        logBox: document.getElementById("logBox"),
    };

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
    };

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

    async function fetchStressPayload(projectId, targetPoints) {
        const mode = getDataMode();
        const url = mode === "tif"
            ? `/api/projects/${encodeURIComponent(projectId)}/tif-stress-json?target_points=${encodeURIComponent(targetPoints)}&include_invalid_vertices=true`
            : `/api/stress/synthetic-grid-json?target_points=${encodeURIComponent(targetPoints)}&include_invalid_vertices=true`;
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

    async function loadAndRender(targetPoints) {
        const mode = getDataMode();
        const projectId = String(dom.projectSelect.value || "").trim();
        if (mode === "tif" && !projectId) {
            throw new Error("没有可用项目");
        }

        const request = await fetchStressPayload(projectId, targetPoints);
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
        const mode = getDataMode();

        state.running = true;
        state.runToken += 1;
        const token = state.runToken;

        state.lastStableCount = 0;
        state.lastStableBytes = 0;

        let stopReason = "";
        let testedSteps = 0;
        let skippedSteps = 0;
        let prevPredictedStride = 0;

        logLine(`开始自动压测: start=${startCount}, step=${stepCount}, max=${maxCount}, fpsFloor=${fpsThreshold}`);

        for (let target = startCount; target <= maxCount; target += stepCount) {
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
                continue;
            }

            const stepStart = performance.now();
            const rendered = await loadAndRender(target);
            testedSteps += 1;
            prevPredictedStride = rendered.stride || predictedStride || prevPredictedStride;
            await new Promise((resolve) => window.setTimeout(resolve, 1200));
            const stepCostMs = performance.now() - stepStart;
            const fpsNow = state.currentFps;

            logLine(`判定: target=${target}, fps=${fpsNow.toFixed(1)}, total=${stepCostMs.toFixed(1)}ms`);

            const tooSlow = fpsNow < fpsThreshold;
            const tooHeavy = state.currentParseMs > 3500 || state.currentBuildMs > 3500 || stepCostMs > 12000;
            if (tooSlow || tooHeavy) {
                const reason = [];
                if (tooSlow) {
                    reason.push(`fps ${fpsNow.toFixed(1)} < ${fpsThreshold}`);
                }
                if (tooHeavy) {
                    reason.push("解析/建模/总耗时过高");
                }
                stopReason = `达到阈值: ${reason.join(" + ")}`;
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
            loadAndRender(target).catch((error) => {
                logLine(`错误: ${toErrorText(error)}`);
            });
        });

        dom.renderOnceBtn.addEventListener("click", () => {
            const target = clampInt(dom.startCountInput.value, 2000000, 10000, 10000000);
            loadAndRender(target).catch((error) => {
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

        animate();
        logLine("压测页已就绪：按你的原始方案测试单包 JSON（色带+折线）的卡顿阈值。");
    }

    bootstrap().catch((error) => {
        logLine(`初始化失败: ${error.message}`);
    });
})();
