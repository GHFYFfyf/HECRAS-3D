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
    const TILE_STATIC_REBUILD_DELAY_MS = 80;
    const TILE_CENTER_MARKER_SIZE = 36;
    const TILE_CENTER_MARKER_Z_OFFSET = 12;
    const TILE_NEIGHBOR_RING = 1;
    const TARGET_VIEW_POINTS = 30000;
    const MAX_DYNAMIC_STRIDE = 32;
    const TILE_FETCH_CONCURRENCY = 4;
    const TIF_TILE_BINARY_MAGIC = 0x54494631;
    const TIF_TILE_BINARY_HEADER_INT32_COUNT = 11;
    const PERFORMANCE_MAX_PIXEL_RATIO = 1.5;

    // Main canvas mount node. Abort early if template is not loaded as expected.
    const container = document.getElementById("threeRoot");
    if (!container) {
        return;
    }

    // Optional HUD fields in the top-right panel (load time / fps).
    const perfHud = document.getElementById("perfHud");
    const hudLoad = document.getElementById("hudLoad");
    const hudFps = document.getElementById("hudFps");

    /**
     * ensureHudLine
     * 主要功能: 在 DOM 的 HUD 面板中确保存在指定的行，如果不存在则创建它。
     * 输入参数:
     *   - id: 元素 ID (string)
     *   - label: 显示的标签文本 (string)
     *   - defaultText: 初始显示的默认值 (string)
     * 输出: 返回找到或创建的 span 元素对象 (HTMLElement|null)
     */
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
    const hudFetchMode = ensureHudLine("hudFetchMode", "Fetch", "--");
    const hudFetchBytes = ensureHudLine("hudFetchBytes", "Bytes", "--");
    const hudFetchPacket = ensureHudLine("hudFetchPacket", "Packet", "--");
    const hudTimingResolve = ensureHudLine("hudTimingResolve", "T-Resolve", "--");
    const hudTimingMetaFetch = ensureHudLine("hudTimingMetaFetch", "T-MetaFetch", "--");
    const hudTimingMetaParse = ensureHudLine("hudTimingMetaParse", "T-MetaParse", "--");
    const hudTimingMetaServer = ensureHudLine("hudTimingMetaServer", "T-MetaSrv", "--");
    const hudTimingCull = ensureHudLine("hudTimingCull", "T-Cull", "--");
    const hudTimingFetch = ensureHudLine("hudTimingFetch", "T-Fetch", "--");
    const hudTimingRebuild = ensureHudLine("hudTimingRebuild", "T-Rebuild", "--");
    const hudTimingUpdate = ensureHudLine("hudTimingUpdate", "T-Update", "--");

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
        fps: document.getElementById("perfRealtimeFps"),
        drawCalls: document.getElementById("perfDrawCalls"),
        triangles: document.getElementById("perfTriangles"),
        stage: document.getElementById("perfStage"),
    };

    const pageStartAt = performance.now();
    const perfAgg = {
        samples: 0,
        serverGenMs: 0,
        serverTotalMs: 0,
        fetchMs: 0,
        parseMs: 0,
    };
    const phaseAgg = {
        updateSamples: 0,
        resolveMs: 0,
        metaFetchMs: 0,
        metaParseMs: 0,
        metaServerBreakdown: "--",
        collectVisibleMsSum: 0,
        fetchTilesMsSum: 0,
        rebuildMsSum: 0,
        updateTotalMsSum: 0,
    };

    const setPerfText = (el, text) => {
        if (el) {
            el.textContent = text;
        }
    };

    const formatMs = (value) => `${Number(value).toFixed(1)} ms`;

    const parseServerTiming = (headerValue) => {
        const result = { total: 0, gen: 0, metrics: {} };
        const text = String(headerValue || "");
        if (!text) {
            return result;
        }
        const entries = text.split(",");
        for (let i = 0; i < entries.length; i += 1) {
            const entry = entries[i].trim();
            if (!entry) {
                continue;
            }
            const nameMatch = entry.match(/^([^;\s,]+)/);
            const durMatch = entry.match(/dur=([0-9.]+)/i);
            if (!nameMatch || !durMatch) {
                continue;
            }
            const metricName = String(nameMatch[1] || "").toLowerCase();
            const durationMs = Number(durMatch[1]) || 0;
            result.metrics[metricName] = durationMs;
        }
        result.total = Number(result.metrics.total) || 0;
        result.gen = Number(result.metrics.gen) || 0;
        return result;
    };

    const updatePhaseHud = () => {
        const n = Math.max(phaseAgg.updateSamples, 1);
        setPerfText(hudTimingResolve, phaseAgg.resolveMs > 0 ? formatMs(phaseAgg.resolveMs) : "--");
        setPerfText(hudTimingMetaFetch, phaseAgg.metaFetchMs > 0 ? formatMs(phaseAgg.metaFetchMs) : "--");
        setPerfText(hudTimingMetaParse, phaseAgg.metaParseMs > 0 ? formatMs(phaseAgg.metaParseMs) : "--");
        setPerfText(hudTimingMetaServer, phaseAgg.metaServerBreakdown || "--");
        setPerfText(hudTimingCull, formatMs(phaseAgg.collectVisibleMsSum / n));
        setPerfText(hudTimingFetch, formatMs(phaseAgg.fetchTilesMsSum / n));
        setPerfText(hudTimingRebuild, formatMs(phaseAgg.rebuildMsSum / n));
        setPerfText(hudTimingUpdate, formatMs(phaseAgg.updateTotalMsSum / n));
    };

    const recordMetaTiming = (timing) => {
        if (!timing) {
            return;
        }
        phaseAgg.metaFetchMs = Number(timing.fetchMs) || 0;
        phaseAgg.metaParseMs = Number(timing.parseMs) || 0;
        const metricNames = ["read", "mask", "stats", "integral", "build", "gen"];
        const parts = [];
        for (let i = 0; i < metricNames.length; i += 1) {
            const name = metricNames[i];
            const value = Number(timing.serverMetrics?.[name]);
            if (Number.isFinite(value) && value > 0) {
                parts.push(`${name}:${value.toFixed(1)}`);
            }
        }
        phaseAgg.metaServerBreakdown = parts.length ? parts.join(" ") : "--";
        updatePhaseHud();
    };

    const recordTileUpdateTiming = (timing) => {
        phaseAgg.updateSamples += 1;
        phaseAgg.collectVisibleMsSum += Number(timing.collectVisibleMs) || 0;
        phaseAgg.fetchTilesMsSum += Number(timing.fetchTilesMs) || 0;
        phaseAgg.rebuildMsSum += Number(timing.rebuildMs) || 0;
        phaseAgg.updateTotalMsSum += Number(timing.totalMs) || 0;
        updatePhaseHud();
    };

    const updatePerfFromFetch = (timing, stage) => {
        perfAgg.samples += 1;
        perfAgg.serverGenMs += timing.serverGenMs;
        perfAgg.serverTotalMs += timing.serverTotalMs;
        perfAgg.fetchMs += timing.fetchMs;
        perfAgg.parseMs += timing.parseMs;

        const n = Math.max(perfAgg.samples, 1);
        const avgGen = perfAgg.serverGenMs / n;
        const avgTotal = perfAgg.serverTotalMs / n;
        const avgFetch = perfAgg.fetchMs / n;
        const avgParse = perfAgg.parseMs / n;
        const avgBackendTransfer = Math.max(0, avgFetch - avgTotal);

        setPerfText(perfDom.dataGen, formatMs(avgGen));
        setPerfText(perfDom.backendTransfer, formatMs(avgBackendTransfer));
        setPerfText(perfDom.frontendFetch, formatMs(avgFetch));
        setPerfText(perfDom.frontendParse, formatMs(avgParse));
        setPerfText(perfDom.stage, stage);
    };

    // URL state: /three?project_id=... .
    const params = new URLSearchParams(window.location.search);
    let projectId = params.get("project_id");
    const DEBUG_FETCH_LOG = params.get("debug_fetch") === "1";
    const SHOW_TILE_MARKERS = params.get("show_tile_markers") === "1";
    const SHOW_BASE_POINT_CLOUD = params.get("show_base_points") === "1";
    const DEBUG_BINARY_PREVIEW_BYTES = 64;
    let hasLoggedBinarySample = false;
    let hasLoggedJsonFallback = false;


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
            const requestStart = performance.now();
            const response = await fetch(
                `/api/projects/${encodeURIComponent(resolvedProjectId)}/tif-tiles?target_points_per_tile=${TILE_TARGET_POINTS}`,
            );
            const fetchDone = performance.now();
            if (!response.ok) {
                throw new Error(`Failed to load tif tile metadata: HTTP ${response.status}`);
            }
            const parseStart = performance.now();
            const payload = await response.json();
            const parseDone = performance.now();
            const serverTiming = parseServerTiming(response.headers.get("server-timing"));
            payload._meta_timing = {
                serverGenMs: serverTiming.gen,
                serverTotalMs: serverTiming.total,
                serverMetrics: serverTiming.metrics,
                fetchMs: fetchDone - requestStart,
                parseMs: parseDone - parseStart,
                totalMs: parseDone - requestStart,
            };
            return payload;
        },

        /**
         * fetchTifTilePayload
         * Function: Fetch terrain points for one tile window.
         * Input: resolvedProjectId (string), tile (tile metadata record).
         * Output: Promise<{points, vertices, ...}>.
         */
        async fetchTifTilePayload(resolvedProjectId, tile, stride = 1) {
            const requestStart = performance.now();
            const query = new URLSearchParams({
                row_start: String(tile.row_start),
                row_end: String(tile.row_end),
                col_start: String(tile.col_start),
                col_end: String(tile.col_end),
                stride: String(Math.max(1, Math.min(MAX_DYNAMIC_STRIDE, Math.trunc(stride) || 1))),
            });
            const binaryUrl = `/api/projects/${encodeURIComponent(resolvedProjectId)}/tif-tile-points-binary?${query.toString()}`;
            const legacyUrl = `/api/projects/${encodeURIComponent(resolvedProjectId)}/tif-tile-points?${query.toString()}`;

            const binaryResponse = await fetch(binaryUrl, {
                headers: { Accept: "application/octet-stream, application/json" },
            });

            if (binaryResponse.ok) {
                const contentType = String(binaryResponse.headers.get("content-type") || "").toLowerCase();
                const serverTiming = parseServerTiming(binaryResponse.headers.get("server-timing"));
                if (contentType.includes("application/octet-stream")) {
                    const buffer = await binaryResponse.arrayBuffer();
                    const fetchDone = performance.now();
                    const parseStart = performance.now();
                    const payload = this.parseTifTileBinaryPayload(buffer);
                    const parseDone = performance.now();
                    payload._transport = "binary";
                    payload._transport_bytes = buffer.byteLength;
                    payload._transport_content_type = contentType;
                    updatePerfFromFetch(
                        {
                            serverGenMs: serverTiming.gen,
                            serverTotalMs: serverTiming.total,
                            fetchMs: fetchDone - requestStart,
                            parseMs: parseDone - parseStart,
                        },
                        "Terrain tile(binary)",
                    );
                    return payload;
                }
                const parseStart = performance.now();
                const payload = await binaryResponse.json();
                const parseDone = performance.now();
                payload._transport = "binary-endpoint-json";
                payload._transport_content_type = contentType;
                updatePerfFromFetch(
                    {
                        serverGenMs: serverTiming.gen,
                        serverTotalMs: serverTiming.total,
                        fetchMs: parseStart - requestStart,
                        parseMs: parseDone - parseStart,
                    },
                    "Terrain tile(json)",
                );
                return payload;
            }

            // Compatibility fallback for older backend without binary endpoint.
            if (binaryResponse.status !== 404) {
                throw new Error(`Failed to load tif tile points (binary): HTTP ${binaryResponse.status}`);
            }

            const legacyResponse = await fetch(legacyUrl, { headers: { Accept: "application/json" } });
            if (!legacyResponse.ok) {
                throw new Error(`Failed to load tif tile points: HTTP ${legacyResponse.status}`);
            }
            const parseStart = performance.now();
            const payload = await legacyResponse.json();
            const parseDone = performance.now();
            const serverTiming = parseServerTiming(legacyResponse.headers.get("server-timing"));
            payload._transport = "json-fallback";
            payload._transport_content_type = "application/json";
            payload._transport_fallback_reason = `binary status ${binaryResponse.status}`;
            updatePerfFromFetch(
                {
                    serverGenMs: serverTiming.gen,
                    serverTotalMs: serverTiming.total,
                    fetchMs: parseStart - requestStart,
                    parseMs: parseDone - parseStart,
                },
                "Terrain tile(fallback)",
            );
            if (DEBUG_FETCH_LOG || !hasLoggedJsonFallback) {
                console.warn("[tif-tile-fetch] fallback to JSON", {
                    reason: payload._transport_fallback_reason,
                    tile: {
                        row_start: tile.row_start,
                        row_end: tile.row_end,
                        col_start: tile.col_start,
                        col_end: tile.col_end,
                    },
                });
                hasLoggedJsonFallback = true;
            }
            return payload;
        },

        /**
         * formatHexPreview
         * 主要功能: 将 ArrayBuffer 转换为可阅读的十六进制文本预览。
         * 输入参数:
         *   - buffer: 需要预览的 ArrayBuffer (ArrayBuffer)
         *   - maxBytes: 最大显示的字节数 (number)
         * 输出: 十六进制字符串 (string)
         */
        formatHexPreview(buffer, maxBytes = DEBUG_BINARY_PREVIEW_BYTES) {
            const bytes = new Uint8Array(buffer, 0, Math.min(maxBytes, buffer.byteLength));
            const parts = new Array(bytes.length);
            for (let i = 0; i < bytes.length; i += 1) {
                parts[i] = bytes[i].toString(16).padStart(2, "0");
            }
            return parts.join(" ");
        },

        /**
         * parseTifTileBinaryPayload
         * Function: Decode compact tile binary payload into legacy JSON-like shape.
         * Input: ArrayBuffer from /tif-tile-points-binary.
         * Output: { project_id, point_count, stride, window, grid, vertices, points }.
         */
        parseTifTileBinaryPayload(buffer) {
            const view = new DataView(buffer);
            const headerBytes = TIF_TILE_BINARY_HEADER_INT32_COUNT * 4;
            if (buffer.byteLength < headerBytes) {
                throw new Error("Invalid tif binary payload: header too short");
            }

            const magic = view.getInt32(0, true) >>> 0;
            if (magic !== TIF_TILE_BINARY_MAGIC) {
                throw new Error("Invalid tif binary payload: bad magic");
            }

            const projectIdFromPayload = view.getInt32(4, true);
            const stride = view.getInt32(8, true);
            const rowStart = view.getInt32(12, true);
            const rowEnd = view.getInt32(16, true);
            const colStart = view.getInt32(20, true);
            const colEnd = view.getInt32(24, true);
            const gridRows = view.getInt32(28, true);
            const gridCols = view.getInt32(32, true);
            const sampleCount = view.getInt32(36, true);
            const pointCountFromHeader = view.getInt32(40, true);

            const headerSummary = {
                magic: `0x${magic.toString(16)}`,
                project_id: projectIdFromPayload,
                stride,
                row_start: rowStart,
                row_end: rowEnd,
                col_start: colStart,
                col_end: colEnd,
                grid_rows: gridRows,
                grid_cols: gridCols,
                sample_count: sampleCount,
                point_count: pointCountFromHeader,
                total_bytes: buffer.byteLength,
            };

            const hexPreview = this.formatHexPreview(buffer);
            if (DEBUG_FETCH_LOG || !hasLoggedBinarySample) {
                console.log("[tif-tile-binary] header", headerSummary);
                console.log("[tif-tile-binary] head hex", hexPreview);
                hasLoggedBinarySample = true;
            }

            if (sampleCount < 0) {
                throw new Error("Invalid tif binary payload: negative sample count");
            }

            let offset = headerBytes;
            const i32Bytes = sampleCount * 4;
            const f32Bytes = sampleCount * 4;
            const u8Bytes = sampleCount;
            const expectedBytes = headerBytes + i32Bytes + i32Bytes + f32Bytes + f32Bytes + f32Bytes + u8Bytes;
            if (buffer.byteLength < expectedBytes) {
                throw new Error("Invalid tif binary payload: truncated arrays");
            }

            const rows = new Int32Array(buffer, offset, sampleCount);
            offset += i32Bytes;
            const cols = new Int32Array(buffer, offset, sampleCount);
            offset += i32Bytes;
            const xVals = new Float32Array(buffer, offset, sampleCount);
            offset += f32Bytes;
            const yVals = new Float32Array(buffer, offset, sampleCount);
            offset += f32Bytes;
            const zVals = new Float32Array(buffer, offset, sampleCount);
            offset += f32Bytes;
            const valid = new Uint8Array(buffer, offset, sampleCount);

            const vertices = new Array(sampleCount);
            const points = [];
            for (let i = 0; i < sampleCount; i += 1) {
                const row = rows[i];
                const col = cols[i];
                const x = Number(xVals[i]);
                const y = Number(yVals[i]);
                const z = Number(zVals[i]);
                const isValid = valid[i] !== 0 && Number.isFinite(z);

                vertices[i] = {
                    sample_row: row,
                    sample_col: col,
                    row,
                    col,
                    x,
                    y,
                    elevation: isValid ? z : null,
                    valid: isValid,
                };

                if (isValid) {
                    points.push([x, y, z]);
                }
            }

            return {
                project_id: projectIdFromPayload,
                point_count: Number.isFinite(pointCountFromHeader) ? pointCountFromHeader : points.length,
                stride,
                _binary_header: headerSummary,
                _binary_head_hex: hexPreview,
                window: {
                    row_start: rowStart,
                    row_end: rowEnd,
                    col_start: colStart,
                    col_end: colEnd,
                },
                grid: {
                    rows: gridRows,
                    cols: gridCols,
                },
                vertices,
                points,
            };
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
         * logTileMetaSummary
         * 主要功能: 打印瓦片元数据的简要统计信息到控制台。
         * 输入参数:
         *   - payload: 包含 tile_count, tile_grid, valid_point_count 等的元数据对象 (object)
         * 输出: 无 (控制台输出)
         */
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
         * createIndexedSurfaceMesh
         * Function: Build one batched indexed triangle surface from sampled grid vertices.
         * Color rule: each triangle uses one flat color sampled from triangle-center elevation.
         * Input: vertices, centerX/centerY (reserved), minZ, zRange, sampleStep.
         * Output: THREE.Mesh or null.
         */
        createIndexedSurfaceMesh(vertices, centerX, centerY, minZ, zRange, sampleStep = 1) {
            if (!Array.isArray(vertices) || !vertices.length) {
                return null;
            }

            const keyToGeometryIndex = new Map();
            const geometryPositions = [];
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

            const trianglePositions = [];
            const triangleColors = [];
            const triangleMeshIndices = [];
            let vertexCursor = 0;

            for (let i = 0; i < triangleIndices.length; i += 3) {
                const a = triangleIndices[i];
                const b = triangleIndices[i + 1];
                const c = triangleIndices[i + 2];

                const baseA = a * 3;
                const baseB = b * 3;
                const baseC = c * 3;

                const ax = geometryPositions[baseA];
                const ay = geometryPositions[baseA + 1];
                const az = geometryPositions[baseA + 2];
                const bx = geometryPositions[baseB];
                const by = geometryPositions[baseB + 1];
                const bz = geometryPositions[baseB + 2];
                const cx = geometryPositions[baseC];
                const cy = geometryPositions[baseC + 1];
                const cz = geometryPositions[baseC + 2];

                const centerZ = (az + bz + cz) / 3;
                const [r, g, bColor] = getColorForZ(centerZ);

                trianglePositions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
                triangleColors.push(r, g, bColor, r, g, bColor, r, g, bColor);
                triangleMeshIndices.push(vertexCursor, vertexCursor + 1, vertexCursor + 2);
                vertexCursor += 3;
            }

            if (!trianglePositions.length) {
                return null;
            }

            const surfaceGeometry = new THREE.BufferGeometry();
            surfaceGeometry.setAttribute("position", new THREE.Float32BufferAttribute(trianglePositions, 3));
            surfaceGeometry.setAttribute("color", new THREE.Float32BufferAttribute(triangleColors, 3));
            surfaceGeometry.setIndex(triangleMeshIndices);
            surfaceGeometry.computeVertexNormals();

            const surfaceMaterial = new THREE.MeshLambertMaterial({
                vertexColors: true,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.82,
                flatShading: true,
            });

            return new THREE.Mesh(surfaceGeometry, surfaceMaterial);
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
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PERFORMANCE_MAX_PIXEL_RATIO));
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
                setPerfText(perfDom.fps, fps.toFixed(1));
                setPerfText(perfDom.drawCalls, String(this.renderer.info.render.calls || 0));
                setPerfText(perfDom.triangles, String(this.renderer.info.render.triangles || 0));
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
        const ttiMarks = {
            start: loadStartAt,
            afterInit: loadStartAt,
            afterResolveProject: loadStartAt,
            afterMeta: loadStartAt,
        };
        RenderModule.init();
        ttiMarks.afterInit = performance.now();

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

        const resolveStartAt = performance.now();
        projectId = await DataModule.resolveProjectId(projectId, params);
        phaseAgg.resolveMs = performance.now() - resolveStartAt;
        updatePhaseHud();
        ttiMarks.afterResolveProject = performance.now();
        const tileMeta = await DataModule.fetchTifTilesMeta(projectId);
        recordMetaTiming(tileMeta._meta_timing);
        ttiMarks.afterMeta = performance.now();
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
        let terrainSurface = null;
        let firstRenderable = true;
        let refreshSeq = 0;
        let refreshTimer = null;
        let staticRebuildTimer = null;
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

        /**
         * expandTilesWithNeighborRing
         * 主要功能: 根据种子瓦片列表，扩展包含其周围指定层数(TILE_NEIGHBOR_RING)的所有相邻瓦片。
         * 输入参数:
         *   - seedTiles: 核心可视瓦片列表 (array)
         * 输出: 包含核心和相邻所有有效瓦片的列表 (array)
         */
        const expandTilesWithNeighborRing = (seedTiles, ringDepth = TILE_NEIGHBOR_RING) => {
            if (!Array.isArray(seedTiles) || seedTiles.length === 0) {
                return [];
            }
            const safeRingDepth = Math.max(0, Math.trunc(ringDepth) || 0);
            const expanded = [];
            const seen = new Set();

            for (let i = 0; i < seedTiles.length; i += 1) {
                const seed = seedTiles[i];
                const seedRow = Number(seed.tile_row);
                const seedCol = Number(seed.tile_col);
                if (!Number.isFinite(seedRow) || !Number.isFinite(seedCol)) {
                    continue;
                }

                for (let dr = -safeRingDepth; dr <= safeRingDepth; dr += 1) {
                    for (let dc = -safeRingDepth; dc <= safeRingDepth; dc += 1) {
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

        /**
         * formatTileList
         * 主要功能: 将瓦片列表格式化为易读的 r#c# 字符串列表。
         * 输入参数:
         *   - tileList: 瓦片对象数组 (array)
         *   - maxLen: 最多显示的格式化长度 (number)
         * 输出: 格式化后的字符串 (string)
         */
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

        /**
         * updateTileHud
         * 主要功能: 计算并展示当前渲染和可视缓存瓦片的详细 HUD 信息（字节、数量、丢包、步长等）。
         * 输入参数:
         *   - visibleTiles: 当前视锥体内的瓦片 (array)
         *   - dynamicStride: 当前使用的抽希步长 (number)
         *   - renderedPointCount: 实际渲染的点数 (number)
         *   - visiblePointEstimate: 原始（由元数据估算）的可视点数 (number)
         * 输出: 无 (更新 UI)
         */
        const updateTileHud = (visibleTiles, dynamicStride, renderedPointCount, visiblePointEstimate) => {
            const tileCount = Number(tileMeta.tile_count) || tiles.length;
            const validTotal = Number(tileMeta.valid_point_count) || 0;
            const targetPerTile = Number(tileMeta.target_points_per_tile) || TILE_TARGET_POINTS;
            const approxPerTile = tileCount > 0 ? Math.round(validTotal / tileCount) : 0;
            const loadedTiles = tiles.filter((tile) => tileCache.has(tileKey(tile)));
            let binaryCount = 0;
            let jsonFallbackCount = 0;
            let otherCount = 0;
            let totalTransportBytes = 0;

            for (let i = 0; i < visibleTiles.length; i += 1) {
                const cached = tileCache.get(tileKey(visibleTiles[i]));
                if (!cached) {
                    continue;
                }
                if (cached._transport === "binary") {
                    binaryCount += 1;
                } else if (cached._transport === "json-fallback") {
                    jsonFallbackCount += 1;
                } else if (cached._transport) {
                    otherCount += 1;
                }

                if (Number.isFinite(cached._transport_bytes)) {
                    totalTransportBytes += Number(cached._transport_bytes);
                }
            }

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
            if (hudFetchMode) {
                hudFetchMode.textContent = `bin ${binaryCount} / json ${jsonFallbackCount} / other ${otherCount}`;
            }
            if (hudFetchBytes) {
                hudFetchBytes.textContent = totalTransportBytes > 0 ? `${(totalTransportBytes / 1024).toFixed(1)} KB` : "--";
            }
            if (hudFetchPacket) {
                let packetText = "--";
                for (let i = 0; i < visibleTiles.length; i += 1) {
                    const cached = tileCache.get(tileKey(visibleTiles[i]));
                    if (!cached || cached._transport !== "binary" || !cached._binary_header) {
                        continue;
                    }
                    const h = cached._binary_header;
                    packetText = `m ${h.magic} s ${h.sample_count} p ${h.point_count} b ${h.total_bytes}`;
                    break;
                }
                hudFetchPacket.textContent = packetText;
            }
        };

        /**
         * updateTileMarkerStates
         * 主要功能: 更新瓦片中心标记辅助对象的视觉状态（颜色、透明度）。
         * 输入参数: visibleTiles (array)
         * 输出: 无 (副作用: 改变场景材质)
         */
        const updateTileMarkerStates = (visibleTiles) => {
            if (!SHOW_TILE_MARKERS) {
                return;
            }
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

        /**
         * createTileCenterMarkers
         * 主要功能: 为所有瓦片在场景中生成定位标记辅助对象。
         * 输入参数: 无
         * 输出: 无 (副作用: 向场景添加对象)
         */
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
                    renderTiles: expandTilesWithNeighborRing(seedTiles, TILE_NEIGHBOR_RING),
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
                renderTiles: expandTilesWithNeighborRing([nearest], TILE_NEIGHBOR_RING),
            };
        };

        const rebuildSceneFromVisibleTiles = (visibleTiles, sampleStep) => {
            const renderStartAt = performance.now();
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
            if (SHOW_BASE_POINT_CLOUD) {
                cloud = MeshModule.createWhitePointCloud(positions, colors);
                RenderModule.scene.add(cloud);
            }

            if (terrainSurface) {
                terrainSurface.geometry.dispose();
                terrainSurface.material.dispose();
                RenderModule.scene.remove(terrainSurface);
                terrainSurface = null;
            }

            terrainSurface = MeshModule.createIndexedSurfaceMesh(mergedVertices, centerX, centerY, minZ, zRange, sampleStep);
            if (terrainSurface) {
                RenderModule.scene.add(terrainSurface);
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
                setPerfText(perfDom.tti, formatMs(performance.now() - pageStartAt));
                firstRenderable = false;
            }

            const elapsedMs = performance.now() - loadStartAt;
            RenderModule.setLoadHudText(`${elapsedMs.toFixed(1)} ms | tiles ${visibleTiles.length}`);
            setPerfText(perfDom.frontendRender, formatMs(performance.now() - renderStartAt));
            setPerfText(perfDom.stage, "Terrain rebuild");
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
            const updateStartAt = performance.now();
            const skipRebuild = Boolean(options.skipRebuild);
            const requestId = refreshSeq + 1;
            refreshSeq = requestId;

            const collectVisibleStartAt = performance.now();
            const { seedTiles, renderTiles } = collectVisibleTiles();
            const collectVisibleMs = performance.now() - collectVisibleStartAt;
            const visibleTiles = renderTiles;
            const visiblePointEstimate = seedTiles.reduce((acc, tile) => acc + (Number(tile.point_count) || 0), 0);
            const forceStrideOne = seedTiles.length === 1;
            const dynamicStride = forceStrideOne
                ? 1
                : Math.max(
                    1,
                    Math.min(MAX_DYNAMIC_STRIDE, Math.floor(Math.max(visiblePointEstimate, 1) / TARGET_VIEW_POINTS)),
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
                const fetchTilesStartAt = performance.now();
                await runWithConcurrency(taskFactories, TILE_FETCH_CONCURRENCY);
                var fetchTilesMs = performance.now() - fetchTilesStartAt;
            } else {
                var fetchTilesMs = 0;
            }

            if (requestId !== refreshSeq) {
                return;
            }

            let renderedPointCount = 0;
            let rebuildMs = 0;
            if (skipRebuild) {
                for (let i = 0; i < visibleTiles.length; i += 1) {
                    const cached = tileCache.get(tileKey(visibleTiles[i]));
                    if (!cached || !Array.isArray(cached.points)) {
                        continue;
                    }
                    renderedPointCount += cached.points.length;
                }
            } else {
                const rebuildStartAt = performance.now();
                renderedPointCount = rebuildSceneFromVisibleTiles(visibleTiles, dynamicStride);
                rebuildMs = performance.now() - rebuildStartAt;
            }
            updateTileMarkerStates(visibleTiles);
            updateTileHud(visibleTiles, dynamicStride, renderedPointCount, visiblePointEstimate);
            const totalMs = performance.now() - updateStartAt;
            recordTileUpdateTiming({
                collectVisibleMs,
                fetchTilesMs,
                rebuildMs,
                totalMs,
            });
            return {
                collectVisibleMs,
                fetchTilesMs,
                rebuildMs,
                totalMs,
            };
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

        if (SHOW_TILE_MARKERS) {
            createTileCenterMarkers();
        }

        const firstUpdateTiming = await updateVisibleTiles();
        setPerfText(perfDom.ttiInit, formatMs(ttiMarks.afterInit - ttiMarks.start));
        setPerfText(perfDom.ttiProject, formatMs(ttiMarks.afterResolveProject - ttiMarks.afterInit));
        setPerfText(perfDom.ttiMeta, formatMs(ttiMarks.afterMeta - ttiMarks.afterResolveProject));
        setPerfText(perfDom.ttiTiles, formatMs(firstUpdateTiming.fetchTilesMs || 0));
        setPerfText(perfDom.ttiRebuild, formatMs(firstUpdateTiming.rebuildMs || 0));

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

        const scheduleStableRebuild = (delayMs = TILE_STATIC_REBUILD_DELAY_MS) => {
            if (staticRebuildTimer) {
                window.clearTimeout(staticRebuildTimer);
            }
            staticRebuildTimer = window.setTimeout(() => {
                staticRebuildTimer = null;
                queueVisibleRefresh();
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
            if (staticRebuildTimer) {
                window.clearTimeout(staticRebuildTimer);
                staticRebuildTimer = null;
            }
        });

        RenderModule.controls.addEventListener("change", () => {
            const lightDelayMs = controlsInteracting
                ? TILE_INTERACT_UPDATE_DEBOUNCE_MS
                : TILE_VISIBLE_UPDATE_DEBOUNCE_MS;
            // Keep interaction smooth: update visibility/cache without rebuilding mesh.
            scheduleRefresh(lightDelayMs, { skipRebuild: true });
            // Run one heavy rebuild only after camera settles.
            scheduleStableRebuild();
        });

        RenderModule.controls.addEventListener("end", () => {
            controlsInteracting = false;
            if (lastInteractionType === "wheel") {
                // Wheel emits dense events; keep lightweight updates and postpone heavy rebuild.
                scheduleRefresh(TILE_WHEEL_END_DELAY_MS, { skipRebuild: true });
                scheduleStableRebuild(TILE_WHEEL_END_DELAY_MS + TILE_STATIC_REBUILD_DELAY_MS);
                lastInteractionType = "unknown";
                return;
            }
            lastInteractionType = "unknown";
            scheduleRefresh(TILE_VISIBLE_UPDATE_DEBOUNCE_MS, { skipRebuild: true });
            scheduleStableRebuild();
        });
    }

    // Keep UI responsive even if bootstrap fails.
    bootstrap().catch(() => {});
    RenderModule.animate();
})();
