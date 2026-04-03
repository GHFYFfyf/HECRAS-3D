document.addEventListener("DOMContentLoaded", async () => {
    console.info("HEC-RAS dashboard template loaded.");

    const PROJECT_FOCUS_DISTANCE_FACTOR = 1.002;
    const HDF_DEPTH_MAX_POINTS = 80000;
    const FLOOD_POINT_PIXEL_SIZE = 4;

    let autoRotateEnabled = true;
    let autoRotateHandler;
    const projectExtentEntities = new Map();
    let floodPointCollection = null;
    let activeProjectId = null;
    let depthDistributionChart = null;
    let flowHydrographChart = null;
    let velocityHistogramChart = null;
    let chartResizeBound = false;
    let latestStatsPayload = null;
    let latestGridSummary = null;
    let latestFlowPayload = null;
    let hydroAiTriggerButton = null;
    let hydroAiTriggerText = null;
    let hydroAiBubble = null;
    let hydroAiBubbleText = null;
    let hydroAiRequestToken = 0;
    const mercatorProjection = new Cesium.WebMercatorProjection();

    // Grant CesiumJS access to your ion assets
    Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwMjc0YjQ0MS0wOTliLTQ3ZGQtYmZhMi05YTdlYTM5MWUyYmUiLCJpZCI6MzQ5Mjk1LCJpYXQiOjE3NjExODM2Njl9.xKRoBHBK6rfDy85asmx50omBvFw96N48Vq0Z85U9hys";
    let viewer;

    try {
        viewer = new Cesium.Viewer("cesiumContainer", {
            animation: false,
            baseLayerPicker: false,
            fullscreenButton: false,
            vrButton: false,
            geocoder: false,
            homeButton: false,
            infoBox: false,
            sceneModePicker: false,
            selectionIndicator: false,
            timeline: false,
            navigationHelpButton: false,
            navigationInstructionsInitiallyVisible: false,
            skyBox: false,
            skyAtmosphere: false,
            contextOptions: {
                webgl: {
                    alpha: true
                }
            }
        });
    } catch (error) {
        console.error("Failed to create Cesium Viewer:", error);
        return;
    }

    viewer.scene.renderError.addEventListener((scene, error) => {
        console.error("Cesium render error:", error);
    });

    // 移除低部的版权信息
    viewer.cesiumWidget.creditContainer.style.display = "none";
    // 设置背景透明
    viewer.scene.backgroundColor = Cesium.Color.TRANSPARENT;

    function ensureCharts() {
        if (typeof echarts === "undefined") {
            return {
                depthChart: null,
                flowChart: null,
                velocityChart: null,
            };
        }

        const depthContainer = document.getElementById("depthDistributionChart");
        const flowContainer = document.getElementById("flowHydrographChart");
        const velocityContainer = document.getElementById("velocityHistogramChart");

        if (depthContainer && !depthDistributionChart) {
            depthDistributionChart = echarts.init(depthContainer, null, { renderer: "canvas" });
        }
        if (flowContainer && !flowHydrographChart) {
            flowHydrographChart = echarts.init(flowContainer, null, { renderer: "canvas" });
        }
        if (velocityContainer && !velocityHistogramChart) {
            velocityHistogramChart = echarts.init(velocityContainer, null, { renderer: "canvas" });
        }

        if (!chartResizeBound) {
            window.addEventListener("resize", () => {
                if (depthDistributionChart) {
                    depthDistributionChart.resize();
                }
                if (flowHydrographChart) {
                    flowHydrographChart.resize();
                }
                if (velocityHistogramChart) {
                    velocityHistogramChart.resize();
                }
            });
            chartResizeBound = true;
        }

        return {
            depthChart: depthDistributionChart,
            flowChart: flowHydrographChart,
            velocityChart: velocityHistogramChart,
        };
    }

    function setStatsText(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    }

    function requestChartsResize() {
        window.requestAnimationFrame(() => {
            if (depthDistributionChart) {
                depthDistributionChart.resize();
            }
            if (flowHydrographChart) {
                flowHydrographChart.resize();
            }
            if (velocityHistogramChart) {
                velocityHistogramChart.resize();
            }
        });
    }

    function ensureHydroAiElements() {
        if (!hydroAiTriggerButton) {
            hydroAiTriggerButton = document.getElementById("label-ai-trigger");
        }
        if (!hydroAiTriggerText && hydroAiTriggerButton) {
            hydroAiTriggerText = hydroAiTriggerButton.querySelector(".label-ai-trigger__text");
        }
        if (!hydroAiBubble) {
            hydroAiBubble = document.getElementById("hydroAiInsightBubble");
        }
        if (!hydroAiBubbleText) {
            hydroAiBubbleText = document.getElementById("hydroAiInsightText");
        }
    }

    function setHydroAiButtonLoading(isLoading) {
        ensureHydroAiElements();
        if (!hydroAiTriggerButton) {
            return;
        }
        hydroAiTriggerButton.setAttribute("aria-busy", isLoading ? "true" : "false");
        hydroAiTriggerButton.disabled = Boolean(isLoading);
        if (hydroAiTriggerText) {
            hydroAiTriggerText.textContent = isLoading ? "AI总结..." : "AI总结";
        }
    }

    function renderHydroAiBubble({ text, isError = false }) {
        ensureHydroAiElements();
        if (!hydroAiBubble || !hydroAiBubbleText) {
            return;
        }

        hydroAiBubble.classList.toggle("is-error", Boolean(isError));
        hydroAiBubbleText.textContent = text || "暂无可用概括。";
    }

    async function fetchHydroAiSummaryPayload(projectId) {
        const response = await fetch(
            `/api/projects/${encodeURIComponent(projectId)}/hydro-ai-summary`,
            { headers: { Accept: "application/json" } }
        );

        if (!response.ok) {
            throw new Error(`Failed to load hydro AI summary: ${response.status}`);
        }
        return response.json();
    }

    async function handleHydroAiTriggerClick() {
        if (!activeProjectId) {
            renderHydroAiBubble({
                text: "请先点击一个项目卡片，再发起 AI总结。",
                isError: true,
            });
            return;
        }

        const requestToken = hydroAiRequestToken + 1;
        hydroAiRequestToken = requestToken;
        setHydroAiButtonLoading(true);
        renderHydroAiBubble({
            text: "正在读取流量曲线并生成评价...",
            isError: false,
        });

        try {
            const payload = await fetchHydroAiSummaryPayload(activeProjectId);
            if (requestToken !== hydroAiRequestToken) {
                return;
            }

            const summaryText = typeof payload?.summary_text === "string" && payload.summary_text.trim()
                ? payload.summary_text.trim()
                : "暂无可用概括。";
            const geoTextRaw = typeof payload?.geo_insight === "string" ? payload.geo_insight.trim() : "";
            const levelTextRaw = typeof payload?.water_level_assessment === "string" ? payload.water_level_assessment.trim() : "";

            const mergedText = [summaryText, geoTextRaw, levelTextRaw]
                .filter((part) => typeof part === "string" && part.length > 0)
                .join(" ");

            renderHydroAiBubble({
                text: mergedText || "暂无可用概括。",
                isError: !payload?.found,
            });
        } catch (error) {
            console.error("Hydro AI summary request failed:", error);
            if (requestToken !== hydroAiRequestToken) {
                return;
            }
            renderHydroAiBubble({
                text: "AI 请求失败，请稍后重试。",
                isError: true,
            });
        } finally {
            if (requestToken === hydroAiRequestToken) {
                setHydroAiButtonLoading(false);
            }
        }
    }

    function initHydroAiControls() {
        ensureHydroAiElements();
        if (!hydroAiTriggerButton) {
            return;
        }

        hydroAiTriggerButton.addEventListener("click", () => {
            handleHydroAiTriggerClick();
        });
    }

    function updateDepthChart(depthBins) {
        const { depthChart } = ensureCharts();
        if (!depthChart) {
            return;
        }

        depthChart.setOption({
            animationDuration: 450,
            tooltip: {
                trigger: "axis",
                axisPointer: { type: "shadow" },
                backgroundColor: "rgba(5,16,30,0.92)",
                borderColor: "rgba(103,187,255,0.4)",
                textStyle: { color: "#d8ebff", fontSize: 10 }
            },
            grid: { left: 14, right: 8, top: 14, bottom: 18, containLabel: true },
            xAxis: {
                type: "category",
                data: depthBins.map((item) => item.name),
                axisLine: { lineStyle: { color: "rgba(123,166,202,0.35)" } },
                axisLabel: { color: "#7ba6ca", fontSize: 9 },
                axisTick: { show: false }
            },
            yAxis: {
                type: "value",
                splitNumber: 3,
                splitLine: { lineStyle: { color: "rgba(123,166,202,0.16)" } },
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { color: "#6f93b1", fontSize: 9 }
            },
            visualMap: {
                show: false,
                min: 0,
                max: Math.max(...depthBins.map((item) => item.count), 1),
                dimension: 1,
                inRange: {
                    color: ["#14385f", "#1d6fbc", "#79c6ff"]
                }
            },
            series: [{
                type: "bar",
                data: depthBins.map((item) => item.count),
                barWidth: "58%",
                itemStyle: {
                    borderRadius: [4, 4, 0, 0]
                },
                emphasis: {
                    itemStyle: {
                        shadowBlur: 10,
                        shadowColor: "rgba(95,183,255,0.45)"
                    }
                }
            }]
        });
        requestChartsResize();
    }

    function buildVelocityBins(velocityFaces) {
        const bins = [
            { name: "0-0.5", min: 0.0, max: 0.5, count: 0 },
            { name: "0.5-1", min: 0.5, max: 1.0, count: 0 },
            { name: "1-2", min: 1.0, max: 2.0, count: 0 },
            { name: "2-3", min: 2.0, max: 3.0, count: 0 },
            { name: ">=3", min: 3.0, max: Number.POSITIVE_INFINITY, count: 0 },
        ];

        for (let i = 0; i < velocityFaces.length; i += 1) {
            const velocity = Math.abs(Number(velocityFaces[i][2]));
            if (!Number.isFinite(velocity)) {
                continue;
            }
            for (let j = 0; j < bins.length; j += 1) {
                const bin = bins[j];
                if (velocity >= bin.min && velocity < bin.max) {
                    bin.count += 1;
                    break;
                }
            }
        }

        return bins;
    }

    function updateVelocityChart(velocityFaces) {
        const { velocityChart } = ensureCharts();
        if (!velocityChart) {
            return;
        }

        const velocityBins = buildVelocityBins(velocityFaces);
        velocityChart.setOption({
            animationDuration: 450,
            tooltip: {
                trigger: "axis",
                axisPointer: { type: "shadow" },
                backgroundColor: "rgba(8,18,34,0.92)",
                borderColor: "rgba(143,157,255,0.4)",
                textStyle: { color: "#d8ebff", fontSize: 10 }
            },
            grid: { left: 14, right: 8, top: 14, bottom: 18, containLabel: true },
            xAxis: {
                type: "category",
                data: velocityBins.map((item) => item.name),
                axisLine: { lineStyle: { color: "rgba(131,152,255,0.35)" } },
                axisLabel: { color: "#9db1ff", fontSize: 9 },
                axisTick: { show: false }
            },
            yAxis: {
                type: "value",
                splitLine: { lineStyle: { color: "rgba(123,166,202,0.16)" } },
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { color: "#7f95d7", fontSize: 9 }
            },
            series: [{
                type: "bar",
                data: velocityBins.map((item) => item.count),
                barWidth: "58%",
                itemStyle: {
                    borderRadius: [4, 4, 0, 0],
                    color: "rgba(121,132,255,0.55)",
                }
            }]
        });
        requestChartsResize();
    }

    function formatFlow(value) {
        if (!Number.isFinite(value)) {
            return "-";
        }
        const absValue = Math.abs(value);
        if (absValue >= 1000) {
            return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} m3/s`;
        }
        return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} m3/s`;
    }

    function updateFlowChart(flowPayload) {
        latestFlowPayload = flowPayload;

        const { flowChart } = ensureCharts();
        if (!flowChart) {
            return;
        }

        if (!flowPayload?.found || !Array.isArray(flowPayload.series) || flowPayload.series.length === 0) {
            setStatsText("statsFlowPeak", "-");
            setStatsText("statsFlowCurrent", "-");
            flowChart.setOption({
                animationDuration: 300,
                grid: { left: 12, right: 8, top: 18, bottom: 18, containLabel: true },
                xAxis: {
                    type: "value",
                    axisLine: { lineStyle: { color: "rgba(123,166,202,0.35)" } },
                    axisLabel: { color: "#7ba6ca", fontSize: 9 },
                    splitLine: { show: false },
                },
                yAxis: {
                    type: "value",
                    axisLine: { show: false },
                    axisTick: { show: false },
                    axisLabel: { color: "#6f93b1", fontSize: 9 },
                    splitLine: { lineStyle: { color: "rgba(123,166,202,0.16)" } },
                },
                series: [{ type: "line", data: [] }],
                dataZoom: [],
            }, { notMerge: true });
            requestChartsResize();
            return;
        }

        setStatsText("statsFlowPeak", formatFlow(Number(flowPayload.peak_flow)));
        setStatsText("statsFlowCurrent", formatFlow(Number(flowPayload.current_flow)));

        const flowSeries = flowPayload.series
            .map((item) => [Number(item[0]), Number(item[1])])
            .filter((item) => Number.isFinite(item[0]) && Number.isFinite(item[1]));
        const fixedWindowHours = 12;
        const lastHour = flowSeries.length > 0 ? Number(flowSeries[flowSeries.length - 1][0]) : 0;
        const axisMaxHour = Math.max(fixedWindowHours, Math.ceil(Number.isFinite(lastHour) ? lastHour : 0));
        const enableZoom = axisMaxHour > fixedWindowHours;
        const zoomEndValue = axisMaxHour;
        const zoomStartValue = Math.max(0, zoomEndValue - fixedWindowHours);

        flowChart.setOption({
            animationDuration: 450,
            tooltip: {
                trigger: "axis",
                axisPointer: { type: "cross" },
                backgroundColor: "rgba(8,18,34,0.92)",
                borderColor: "rgba(100,219,178,0.45)",
                textStyle: { color: "#d8ebff", fontSize: 10 },
                formatter: (params) => {
                    const item = Array.isArray(params) ? params[0] : params;
                    if (!item || !Array.isArray(item.value)) {
                        return "";
                    }
                    const hour = Number(item.value[0]);
                    const flow = Number(item.value[1]);
                    return `时间: ${Math.round(hour)} h<br/>流量: ${flow.toFixed(2)} m3/s`;
                }
            },
            grid: { left: 14, right: 8, top: 14, bottom: enableZoom ? 34 : 18, containLabel: true },
            xAxis: {
                type: "value",
                min: 0,
                max: axisMaxHour,
                minInterval: 1,
                interval: 1,
                axisLine: { lineStyle: { color: "rgba(108,212,188,0.36)" } },
                axisLabel: {
                    color: "#81d7c4",
                    fontSize: 9,
                    formatter: (value) => `${Math.round(Number(value))} h`
                },
                splitLine: { lineStyle: { color: "rgba(123,166,202,0.12)" } },
            },
            yAxis: {
                type: "value",
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { color: "#7ed8c2", fontSize: 9 },
                splitLine: { lineStyle: { color: "rgba(123,166,202,0.16)" } },
            },
            series: [{
                type: "line",
                smooth: true,
                showSymbol: false,
                data: flowSeries,
                lineStyle: {
                    width: 2,
                    color: "#3ad2aa",
                },
                areaStyle: {
                    color: "rgba(58,210,170,0.2)",
                },
            }],
            dataZoom: enableZoom ? [
                {
                    type: "slider",
                    xAxisIndex: 0,
                    filterMode: "none",
                    zoomLock: true,
                    brushSelect: false,
                    height: 12,
                    bottom: 6,
                    startValue: zoomStartValue,
                    endValue: zoomEndValue,
                    minValueSpan: fixedWindowHours,
                    maxValueSpan: fixedWindowHours,
                    borderColor: "rgba(84,140,126,0.42)",
                    backgroundColor: "rgba(8,24,20,0.38)",
                    fillerColor: "rgba(52,169,139,0.3)",
                    handleSize: 12,
                    moveHandleSize: 16,
                    textStyle: { color: "#8ecfbf", fontSize: 9 },
                },
            ] : [],
        }, { notMerge: true });
        requestChartsResize();
    }

    function resetDepthAndVelocityStats() {
        setStatsText("statsPointCount", "-");
        setStatsText("statsAvgDepth", "-");
        setStatsText("statsMaxDepth", "-");
        setStatsText("statsFloodArea", "-");
        updateDepthChart([
            { name: "0-0.5", count: 0 },
            { name: "0.5-1", count: 0 },
            { name: "1-2", count: 0 },
            { name: "2-3", count: 0 },
            { name: ">=3", count: 0 },
        ]);
        updateVelocityChart([]);
    }

    function resetFlowStats() {
        setStatsText("statsFlowPeak", "-");
        setStatsText("statsFlowCurrent", "-");
        updateFlowChart({ found: false, series: [] });
    }

    function resetHydraulicStats() {
        resetDepthAndVelocityStats();
        resetFlowStats();
    }

    function formatArea(areaSquareMeter) {
        if (!Number.isFinite(areaSquareMeter) || areaSquareMeter <= 0) {
            return "0 m2";
        }
        if (areaSquareMeter >= 1_000_000) {
            return `${(areaSquareMeter / 1_000_000).toFixed(2)} km2`;
        }
        return `${Math.round(areaSquareMeter).toLocaleString("zh-CN")} m2`;
    }

    function buildDepthBins(points) {
        const bins = [
            { name: "0-0.5", min: 0.0, max: 0.5, count: 0 },
            { name: "0.5-1", min: 0.5, max: 1.0, count: 0 },
            { name: "1-2", min: 1.0, max: 2.0, count: 0 },
            { name: "2-3", min: 2.0, max: 3.0, count: 0 },
            { name: ">=3", min: 3.0, max: Number.POSITIVE_INFINITY, count: 0 },
        ];

        for (let i = 0; i < points.length; i += 1) {
            const depth = Number(points[i][4]);
            if (!Number.isFinite(depth) || depth <= 0) {
                continue;
            }
            for (let j = 0; j < bins.length; j += 1) {
                const bin = bins[j];
                if (depth >= bin.min && depth < bin.max) {
                    bin.count += 1;
                    break;
                }
            }
        }

        return bins;
    }

    function updateHydraulicStatsFromPayload(payload, gridSummary) {
        latestStatsPayload = payload;
        latestGridSummary = gridSummary;

        const points = Array.isArray(payload?.points) ? payload.points : [];
        let depthSum = 0;
        let maxDepth = Number.NEGATIVE_INFINITY;
        let validCount = 0;

        for (let i = 0; i < points.length; i += 1) {
            const depth = Number(points[i][4]);
            if (!Number.isFinite(depth) || depth <= 0) {
                continue;
            }
            validCount += 1;
            depthSum += depth;
            if (depth > maxDepth) {
                maxDepth = depth;
            }
        }

        const avgDepth = validCount > 0 ? depthSum / validCount : 0;

        setStatsText("statsPointCount", validCount.toLocaleString("zh-CN"));
        setStatsText("statsAvgDepth", `${avgDepth.toFixed(2)} m`);
        setStatsText("statsMaxDepth", `${(Number.isFinite(maxDepth) ? maxDepth : 0).toFixed(2)} m`);
        const payloadFloodArea = Number(payload?.flood_area_square_meter);
        const summaryFloodArea = Number(gridSummary?.floodArea);
        const floodArea = Number.isFinite(payloadFloodArea)
            ? payloadFloodArea
            : (Number.isFinite(summaryFloodArea) ? summaryFloodArea : 0);
        setStatsText("statsFloodArea", formatArea(floodArea));
        const depthBins = buildDepthBins(points);
        const velocityFaces = Array.isArray(payload?.velocity_faces) ? payload.velocity_faces : [];
        updateDepthChart(depthBins);
        updateVelocityChart(velocityFaces);
    }

    try {
        const imageryLayer = viewer.imageryLayers.addImageryProvider(
            await Cesium.IonImageryProvider.fromAssetId(2411391),
        );
        await viewer.zoomTo(imageryLayer);
    } catch (error) {
        console.log("Failed to load ion imagery, keep default globe:", error);
    }

    viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(105.0, 20.0, 15000000.0),
        orientation: {
            heading: 0.0,
            pitch: -Cesium.Math.PI_OVER_TWO,
            roll: 0.0
        }
    });

    function stopAutoRotate() {
        autoRotateEnabled = false;
    }

    function mercatorPointToCartographic(x, y) {
        return mercatorProjection.unproject(new Cesium.Cartesian3(x, y, 0.0));
    }

    function normalizeDepth(value, minDepth, maxDepth) {
        if (!Number.isFinite(value) || !Number.isFinite(minDepth) || !Number.isFinite(maxDepth)) {
            return 0;
        }
        if (Math.abs(maxDepth - minDepth) < 1e-9) {
            return 0.5;
        }
        return Cesium.Math.clamp((value - minDepth) / (maxDepth - minDepth), 0, 1);
    }

    function sampleDepthRampColor(depthValue, minDepth, maxDepth) {
        const t = normalizeDepth(depthValue, minDepth, maxDepth);
        const stops = [
            { t: 0.0, rgb: [122, 214, 255] },
            { t: 0.35, rgb: [45, 152, 255] },
            { t: 0.7, rgb: [10, 70, 185] },
            { t: 1.0, rgb: [5, 24, 70] },
        ];

        for (let i = 0; i < stops.length - 1; i += 1) {
            const left = stops[i];
            const right = stops[i + 1];
            if (t < left.t || t > right.t) {
                continue;
            }
            const ratio = (t - left.t) / Math.max(right.t - left.t, 1e-9);
            const r = Math.round(left.rgb[0] + (right.rgb[0] - left.rgb[0]) * ratio);
            const g = Math.round(left.rgb[1] + (right.rgb[1] - left.rgb[1]) * ratio);
            const b = Math.round(left.rgb[2] + (right.rgb[2] - left.rgb[2]) * ratio);
            const alpha = 0.38 + 0.52 * t;
            return Cesium.Color.fromBytes(r, g, b, Math.round(alpha * 255));
        }

        return Cesium.Color.fromBytes(5, 24, 70, 230);
    }

    function clearFloodGridOverlay() {
        if (floodPointCollection) {
            viewer.scene.primitives.remove(floodPointCollection);
            floodPointCollection = null;
        }
    }

    function renderFloodGridOverlay(points) {
        clearFloodGridOverlay();

        const validPoints = [];
        let minDepth = Number.POSITIVE_INFINITY;
        let maxDepth = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < points.length; i += 1) {
            const x = Number(points[i][0]);
            const y = Number(points[i][1]);
            const depth = Number(points[i][4]);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(depth) || depth <= 0) {
                continue;
            }
            validPoints.push([x, y, depth]);
            minDepth = Math.min(minDepth, depth);
            maxDepth = Math.max(maxDepth, depth);
        }

        if (validPoints.length === 0) {
            return {
                pointCount: 0,
                minDepth: 0,
                maxDepth: 0,
                floodArea: 0,
            };
        }

        floodPointCollection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());

        for (let i = 0; i < validPoints.length; i += 1) {
            const x = validPoints[i][0];
            const y = validPoints[i][1];
            const depth = validPoints[i][2];
            const cartographic = mercatorPointToCartographic(x, y);
            const color = sampleDepthRampColor(depth, minDepth, maxDepth);
            floodPointCollection.add({
                position: Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0.0),
                color,
                pixelSize: FLOOD_POINT_PIXEL_SIZE,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            });
        }

        return {
            pointCount: validPoints.length,
            minDepth,
            maxDepth,
            floodArea: 0,
        };
    }

    async function fetchFinalDepthPayload(projectId) {
        const response = await fetch(
            `/api/projects/${encodeURIComponent(projectId)}/hdf-water-depth?time_index=-1&max_points=${encodeURIComponent(HDF_DEPTH_MAX_POINTS)}&include_dry=false`,
            { headers: { Accept: "application/json" } }
        );

        if (!response.ok) {
            throw new Error(`Failed to load final depth payload: ${response.status}`);
        }

        return response.json();
    }

    async function fetchFlowHydrographPayload(projectId) {
        const response = await fetch(
            `/api/projects/${encodeURIComponent(projectId)}/flow-hydrograph`,
            { headers: { Accept: "application/json" } }
        );

        if (!response.ok) {
            throw new Error(`Failed to load flow hydrograph payload: ${response.status}`);
        }

        return response.json();
    }

    async function renderProjectFloodAndStats(project) {
        if (!project?.id) {
            clearFloodGridOverlay();
            resetHydraulicStats();
            return;
        }

        const [depthResult, flowResult] = await Promise.allSettled([
            fetchFinalDepthPayload(project.id),
            fetchFlowHydrographPayload(project.id),
        ]);

        if (depthResult.status === "fulfilled") {
            const payload = depthResult.value;
            const gridSummary = renderFloodGridOverlay(payload?.points || []);
            updateHydraulicStatsFromPayload(payload, gridSummary);
        } else {
            console.error("Failed to render flood overlay:", depthResult.reason);
            clearFloodGridOverlay();
            resetDepthAndVelocityStats();
        }

        if (flowResult.status === "fulfilled") {
            updateFlowChart(flowResult.value);
        } else {
            console.error("Failed to render flow hydrograph:", flowResult.reason);
            resetFlowStats();
        }
    }

    function buildRectangleFromProject(project) {
        const minx = Number(project?.bbox_minx);
        const miny = Number(project?.bbox_miny);
        const maxx = Number(project?.bbox_maxx);
        const maxy = Number(project?.bbox_maxy);

        if (![minx, miny, maxx, maxy].every(Number.isFinite)) {
            return null;
        }

        const southwest = mercatorPointToCartographic(minx, miny);
        const northeast = mercatorPointToCartographic(maxx, maxy);
        const west = Math.min(southwest.longitude, northeast.longitude);
        const south = Math.min(southwest.latitude, northeast.latitude);
        const east = Math.max(southwest.longitude, northeast.longitude);
        const north = Math.max(southwest.latitude, northeast.latitude);

        return new Cesium.Rectangle(west, south, east, north);
    }

    function getExtentStyle(isActive) {
        if (isActive) {
            return {
                material: Cesium.Color.TRANSPARENT,
                outlineColor: Cesium.Color.CYAN.withAlpha(0.96),
                outlineWidth: 3,
            };
        }

        return {
            material: Cesium.Color.TRANSPARENT,
            outlineColor: Cesium.Color.CYAN.withAlpha(0.5),
            outlineWidth: 1,
        };
    }

    function applyExtentStyle(entity, isActive) {
        const style = getExtentStyle(isActive);
        entity.rectangle.material = style.material;
        entity.rectangle.outlineColor = style.outlineColor;
        entity.rectangle.outlineWidth = style.outlineWidth;
    }

    function renderProjectExtents(projects) {
        const seenIds = new Set();

        (projects || []).forEach((project) => {
            const rectangle = buildRectangleFromProject(project);
            if (!rectangle) {
                return;
            }

            const projectId = String(project.id);
            seenIds.add(projectId);

            if (!projectExtentEntities.has(projectId)) {
                const entity = viewer.entities.add({
                    name: `${project?.name || "project"}-extent`,
                    rectangle: {
                        coordinates: rectangle,
                        material: Cesium.Color.TRANSPARENT,
                        outline: true,
                        outlineColor: Cesium.Color.CYAN.withAlpha(0.5),
                        outlineWidth: 1,
                        height: 0.0,
                    },
                });
                projectExtentEntities.set(projectId, entity);
            } else {
                projectExtentEntities.get(projectId).rectangle.coordinates = rectangle;
            }
        });

        projectExtentEntities.forEach((entity, projectId) => {
            if (!seenIds.has(projectId)) {
                viewer.entities.remove(entity);
                projectExtentEntities.delete(projectId);
                return;
            }

            applyExtentStyle(entity, projectId === activeProjectId);
        });
    }

    window.focusProjectOnGlobe = (project) => {
        const rectangle = buildRectangleFromProject(project);

        if (!rectangle) {
            console.warn("Project bbox is incomplete, cannot focus globe.", project);
            return;
        }

        const nextProjectId = String(project.id);
        if (activeProjectId && activeProjectId !== nextProjectId) {
            renderHydroAiBubble({
                text: "点击 AI总结 获取右侧评价",
                isError: false,
            });
        }

        stopAutoRotate();

        activeProjectId = nextProjectId;
        renderProjectExtents(window.projectCardsData || []);

        const rectangleDestination = viewer.camera.getRectangleCameraCoordinates(rectangle);
        const adjustedDestination = Cesium.Cartesian3.multiplyByScalar(
            rectangleDestination,
            PROJECT_FOCUS_DISTANCE_FACTOR,
            new Cesium.Cartesian3(),
        );

        viewer.camera.flyTo({
            destination: adjustedDestination,
            orientation: {
                heading: 0.0,
                pitch: -Cesium.Math.PI_OVER_TWO,
                roll: 0.0,
            },
            duration: 1.6,
        });

        renderProjectFloodAndStats(project);
    };

    // 地球自转效果
    autoRotateHandler = () => {
        if (!autoRotateEnabled) {
            return;
        }
        viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, 0.002);
    };
    viewer.clock.onTick.addEventListener(autoRotateHandler);

    window.addEventListener("projects:loaded", (event) => {
        const projects = event.detail || [];
        renderProjectExtents(projects);

        if (!activeProjectId && Array.isArray(projects) && projects.length > 0) {
            window.setTimeout(() => {
                if (!activeProjectId) {
                    window.focusProjectOnGlobe(projects[0]);
                }
            }, 100);
        }
    });

    window.addEventListener("echarts:ready", () => {
        if (latestStatsPayload) {
            updateHydraulicStatsFromPayload(latestStatsPayload, latestGridSummary || { floodArea: 0 });
        } else {
            resetDepthAndVelocityStats();
        }

        if (latestFlowPayload) {
            updateFlowChart(latestFlowPayload);
        } else {
            resetFlowStats();
        }
    });

    if (Array.isArray(window.projectCardsData) && window.projectCardsData.length > 0) {
        renderProjectExtents(window.projectCardsData);
    }

    initHydroAiControls();
    resetHydraulicStats();
});