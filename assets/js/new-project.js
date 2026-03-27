(function () {
    "use strict";

    function applyPillButtonStyle(button, variant) {
        const palette = {
            primary: {
                color: "#cfe0ff",
                border: "rgba(126, 171, 255, 0.78)",
                bg: "transparent"
            },
            danger: {
                color: "#ffd1d1",
                border: "rgba(255, 136, 136, 0.82)",
                bg: "transparent"
            },
            muted: {
                color: "#ffffff",
                border: "rgba(255, 255, 255, 0.62)",
                bg: "transparent"
            },
            disabled: {
                color: "#888",
                border: "rgba(136, 136, 136, 0.5)",
                bg: "transparent"
            }
        };

        const tone = palette[variant] || palette.muted;
        button.style.display = "inline-flex";
        button.style.alignItems = "center";
        button.style.justifyContent = "center";
        button.style.minWidth = "58px";
        button.style.padding = "7px 14px";
        button.style.borderRadius = "999px";
        button.style.border = `1px solid ${tone.border}`;
        button.style.background = tone.bg;
        button.style.color = tone.color;
        button.style.fontSize = "12px";
        button.style.lineHeight = "1";
        button.style.fontWeight = "500";
        button.style.letterSpacing = "0.04em";
        button.style.whiteSpace = "nowrap";
        button.style.cursor = variant === 'disabled' ? "not-allowed" : "pointer";
        button.style.appearance = "none";
        button.style.boxShadow = "none";
        button.style.transition = "all 0.2s";
    }

    let projectCounter = 1;

    function createModal() {
        let modal = document.getElementById("newProjectModal");
        if (modal) return modal;

        modal = document.createElement("div");
        modal.id = "newProjectModal";
        modal.className = "modal-backdrop";
        modal.style.position = "fixed";
        modal.style.inset = "0";
        modal.style.zIndex = "99999";
        modal.style.display = "none";
        modal.style.alignItems = "center";
        modal.style.justifyContent = "center";
        modal.style.background = "rgba(0, 0, 0, 0.62)";
        modal.style.backdropFilter = "blur(10px)";
        modal.style.pointerEvents = "auto";

        const currentProjectsCount = window.projectCardsData ? window.projectCardsData.length : 0;
        const defaultName = `未命名项目${currentProjectsCount + projectCounter}`;

        modal.innerHTML = `
            <div class="modal-panel" style="width: min(520px, calc(100vw - 32px)); padding: 1.5rem; border-radius: 18px; border: 1px solid rgba(255, 255, 255, 0.08); background: linear-gradient(180deg, rgba(17, 19, 24, 0.98) 0%, rgba(10, 11, 14, 0.98) 100%); box-shadow: 0 28px 80px rgba(0, 0, 0, 0.42); pointer-events: auto;">
                <div class="modal-panel__header" style="margin-bottom: 1.25rem;">
                    <h3 class="text-lg font-semibold text-gray-100">新建项目</h3>
                </div>
                
                <div class="flex flex-col gap-4">
                    <div>
                        <label class="block text-xs text-gray-400 mb-1">项目名称</label>
                        <input type="text" id="np-name" value="${defaultName}" class="w-full bg-gray-800/50 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                    </div>
                    
                    <div>
                        <label class="block text-xs text-gray-400 mb-1">TIF 路径</label>
                        <div class="flex gap-2">
                            <input type="text" id="np-tif" placeholder="输入 TIF 绝对路径" class="flex-1 bg-gray-800/50 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                            <button type="button" id="np-btn-tif" class="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 rounded border border-gray-600">选择</button>
                        </div>
                        <input type="file" id="np-file-tif" accept=".tif,.tiff" style="display:none">
                    </div>

                    <div>
                        <label class="block text-xs text-gray-400 mb-1">HDF 路径</label>
                        <div class="flex gap-2">
                            <input type="text" id="np-hdf" placeholder="输入 HDF 绝对路径" class="flex-1 bg-gray-800/50 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                            <button type="button" id="np-btn-hdf" class="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 rounded border border-gray-600">选择</button>
                        </div>
                        <input type="file" id="np-file-hdf" accept=".hdf,.hdf5" style="display:none">
                    </div>

                    <div id="np-error" class="text-xs text-red-400 hidden"></div>

                    <div>
                        <label class="block text-xs text-gray-400 mb-1">项目概况 (可选)</label>
                        <textarea id="np-summary" rows="2" class="w-full bg-gray-800/50 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"></textarea>
                    </div>
                </div>

                <div class="modal-panel__actions" style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem;">
                    <button type="button" id="np-cancel">取消</button>
                    <button type="button" id="np-confirm" disabled>确定</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const btnCancel = modal.querySelector('#np-cancel');
        const btnConfirm = modal.querySelector('#np-confirm');
        
        applyPillButtonStyle(btnCancel, "muted");
        applyPillButtonStyle(btnConfirm, "disabled");

        const tifInput = modal.querySelector('#np-tif');
        const hdfInput = modal.querySelector('#np-hdf');
        const btnTif = modal.querySelector('#np-btn-tif');
        const btnHdf = modal.querySelector('#np-btn-hdf');
        const fileTif = modal.querySelector('#np-file-tif');
        const fileHdf = modal.querySelector('#np-file-hdf');
        const errorDiv = modal.querySelector('#np-error');

        btnTif.addEventListener('click', () => fileTif.click());
        btnHdf.addEventListener('click', () => fileHdf.click());

        fileTif.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                tifInput.value = file.path || file.name;
                onPathChange();
            }
        });

        fileHdf.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                hdfInput.value = file.path || file.name;
                onPathChange();
            }
        });

        let isValid = false;

        async function validateFiles() {
            const tif = tifInput.value.trim();
            const hdf = hdfInput.value.trim();
            
            if (!tif || !hdf) {
                isValid = false;
                updateConfirmButton();
                return;
            }

            try {
                const res = await fetch('/api/projects/check', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tif_path: tif, hdf_path: hdf })
                });
                const data = await res.json();
                
                if (data.ok) {
                    isValid = true;
                    errorDiv.classList.add('hidden');
                    tifInput.style.borderColor = 'rgba(126, 171, 255, 0.78)';
                    hdfInput.style.borderColor = 'rgba(126, 171, 255, 0.78)';
                } else {
                    isValid = false;
                    errorDiv.textContent = data.error || '路径验证失败';
                    errorDiv.classList.remove('hidden');
                    tifInput.style.borderColor = 'rgba(255, 136, 136, 0.82)';
                    hdfInput.style.borderColor = 'rgba(255, 136, 136, 0.82)';
                }
            } catch (err) {
                isValid = false;
                errorDiv.textContent = '验证请求失败';
                errorDiv.classList.remove('hidden');
            }
            updateConfirmButton();
        }

        function updateConfirmButton() {
            btnConfirm.disabled = !isValid;
            applyPillButtonStyle(btnConfirm, isValid ? "primary" : "disabled");
            if (isValid) {
                btnConfirm.style.background = "#2563eb";
                btnConfirm.style.color = "white";
                btnConfirm.style.border = "1px solid #2563eb";
            }
        }

        let timeout;
        function onPathChange() {
            clearTimeout(timeout);
            errorDiv.classList.add('hidden');
            tifInput.style.borderColor = '';
            hdfInput.style.borderColor = '';
            isValid = false;
            updateConfirmButton();
            
            if (tifInput.value.trim() && hdfInput.value.trim()) {
                timeout = setTimeout(validateFiles, 800);
            }
        }

        tifInput.addEventListener('input', onPathChange);
        hdfInput.addEventListener('input', onPathChange);

        btnCancel.addEventListener('click', () => {
            closeModal();
        });

        btnConfirm.addEventListener('click', async () => {
            if (!isValid) return;
            
            btnConfirm.disabled = true;
            btnConfirm.textContent = '创建中...';
            
            try {
                const res = await fetch('/api/projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: modal.querySelector('#np-name').value.trim(),
                        tif_path: tifInput.value.trim(),
                        hdf_path: hdfInput.value.trim(),
                        summary: modal.querySelector('#np-summary').value.trim() || null
                    })
                });
                
                const data = await res.json();
                if (!res.ok || !data.ok) {
                    throw new Error(data.detail || data.error || '创建失败');
                }
                
                projectCounter++;
                closeModal();
                if (window.renderProjectCards) {
                    await window.renderProjectCards();
                }
            } catch (err) {
                errorDiv.textContent = err.message;
                errorDiv.classList.remove('hidden');
                btnConfirm.disabled = false;
                btnConfirm.textContent = '确定';
            }
        });

        return modal;
    }

    function openModal() {
        const modal = createModal();
        modal.style.display = "flex";
        
        const currentProjectsCount = window.projectCardsData ? window.projectCardsData.length : 0;
        modal.querySelector('#np-name').value = `未命名项目${currentProjectsCount + projectCounter}`;
        modal.querySelector('#np-tif').value = '';
        modal.querySelector('#np-hdf').value = '';
        modal.querySelector('#np-summary').value = '';
        modal.querySelector('#np-error').classList.add('hidden');
        modal.querySelector('#np-tif').style.borderColor = '';
        modal.querySelector('#np-hdf').style.borderColor = '';
        
        const btnConfirm = modal.querySelector('#np-confirm');
        btnConfirm.disabled = true;
        btnConfirm.textContent = '确定';
        applyPillButtonStyle(btnConfirm, "disabled");
    }

    function closeModal() {
        const modal = document.getElementById("newProjectModal");
        if (modal) {
            modal.style.display = "none";
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        const btn = document.getElementById('btn-new-project');
        if (btn) {
            btn.addEventListener('click', openModal);
        }
    });

})();
