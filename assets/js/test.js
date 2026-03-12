document.addEventListener("DOMContentLoaded", async () => {
    console.info("HEC-RAS dashboard template loaded.");
    console.log("hello");

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

    // 地球自转效果
    viewer.clock.onTick.addEventListener(() => {
        viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, 0.002); // 调整数值改变自转速度
    });
});