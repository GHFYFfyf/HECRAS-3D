document.addEventListener("DOMContentLoaded", async () => {
    console.info("HEC-RAS dashboard template loaded.");

    const PROJECT_FOCUS_DISTANCE_FACTOR = 1.002;

    let autoRotateEnabled = true;
    let autoRotateHandler;
    const projectExtentEntities = new Map();
    let activeProjectId = null;

    // Grant CesiumJS access to your ion assets
    Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwMjc0YjQ0MS0wOTliLTQ3ZGQtYmZhMi05YTdlYTM5MWUyYmUiLCJpZCI6MzQ5Mjk1LCJpYXQiOjE3NjExODM2Njl9.xKRoBHBK6rfDy85asmx50omBvFw96N48Vq0Z85U9hys";

    // Initialize Cesium Viewer
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
        const projection = new Cesium.WebMercatorProjection();
        return projection.unproject(new Cesium.Cartesian3(x, y, 0.0));
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
                material: Cesium.Color.CYAN.withAlpha(0.14),
                outlineColor: Cesium.Color.CYAN.withAlpha(0.96),
                outlineWidth: 3,
            };
        }

        return {
            material: Cesium.Color.CYAN.withAlpha(0.03),
            outlineColor: Cesium.Color.CYAN.withAlpha(0.35),
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
                        material: Cesium.Color.CYAN.withAlpha(0.03),
                        outline: true,
                        outlineColor: Cesium.Color.CYAN.withAlpha(0.35),
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

        stopAutoRotate();

        activeProjectId = String(project.id);
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
        renderProjectExtents(event.detail || []);
    });

    if (Array.isArray(window.projectCardsData) && window.projectCardsData.length > 0) {
        renderProjectExtents(window.projectCardsData);
    }
});