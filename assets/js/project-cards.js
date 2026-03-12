(function () {
    "use strict";

    const CARDS_API = "/api/projects/cards";
    const DELETE_API_BASE = "/api/projects";

    function applyPillButtonStyle(button, variant) {
        const palette = {
            primary: {
                color: "#cfe0ff",
                border: "rgba(126, 171, 255, 0.78)"
            },
            danger: {
                color: "#ffd1d1",
                border: "rgba(255, 136, 136, 0.82)"
            },
            muted: {
                color: "#d6dee8",
                border: "rgba(214, 222, 232, 0.62)"
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
        button.style.background = "transparent";
        button.style.color = tone.color;
        button.style.fontSize = "12px";
        button.style.lineHeight = "1";
        button.style.fontWeight = "500";
        button.style.letterSpacing = "0.04em";
        button.style.whiteSpace = "nowrap";
        button.style.cursor = "pointer";
        button.style.appearance = "none";
        button.style.boxShadow = "none";
    }

    function ensureDeleteModal() {
        let modal = document.getElementById("deleteProjectModal");
        if (modal) {
            return modal;
        }

        modal = document.createElement("div");
        modal.id = "deleteProjectModal";
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
        modal.innerHTML = `
            <div class="modal-panel">
                <div class="modal-panel__header">
                    <h3 class="text-base font-semibold text-gray-100">删除项目</h3>
                </div>
                <p class="text-sm text-gray-300 leading-6">删除操作不可撤销，是否继续？</p>
                <div class="modal-panel__actions">
                    <button type="button" class="action-pill action-pill--muted" data-role="cancel-delete">否</button>
                    <button type="button" class="action-pill action-pill--danger" data-role="confirm-delete">是</button>
                </div>
            </div>
        `;

        const panel = modal.querySelector(".modal-panel");
    panel.style.width = "min(480px, calc(100vw - 32px))";
    panel.style.padding = "1.5rem";
        panel.style.borderRadius = "18px";
        panel.style.border = "1px solid rgba(255, 255, 255, 0.08)";
        panel.style.background = "linear-gradient(180deg, rgba(17, 19, 24, 0.98) 0%, rgba(10, 11, 14, 0.98) 100%)";
        panel.style.boxShadow = "0 28px 80px rgba(0, 0, 0, 0.42)";
        panel.style.pointerEvents = "auto";

        const actionRow = modal.querySelector(".modal-panel__actions");
        actionRow.style.display = "flex";
        actionRow.style.justifyContent = "flex-end";
        actionRow.style.gap = "0.75rem";
        actionRow.style.marginTop = "1.25rem";

        applyPillButtonStyle(modal.querySelector('[data-role="cancel-delete"]'), "muted");
        applyPillButtonStyle(modal.querySelector('[data-role="confirm-delete"]'), "danger");

        const root = document.getElementById("deleteProjectModalRoot") || document.body;
        root.appendChild(modal);
        return modal;
    }

    function setPageInteractionLocked(locked) {
        const header = document.querySelector("body > header");
        const main = document.querySelector("body > main");

        [header, main].forEach((element) => {
            if (!element) {
                return;
            }

            if (locked) {
                element.setAttribute("inert", "");
                element.style.pointerEvents = "none";
                element.style.userSelect = "none";
            } else {
                element.removeAttribute("inert");
                element.style.pointerEvents = "";
                element.style.userSelect = "";
            }
        });
    }

    function updateProjectState(projects) {
        window.projectCardsData = projects;
        window.dispatchEvent(new CustomEvent("projects:loaded", { detail: projects }));
    }

    async function deleteProject(projectId) {
        const response = await fetch(`${DELETE_API_BASE}/${projectId}`, {
            method: "DELETE",
            headers: { Accept: "application/json" }
        });

        if (!response.ok) {
            throw new Error(`Failed to delete project: ${response.status}`);
        }
    }

    async function openDeleteModal(project) {
        const modal = ensureDeleteModal();
        const confirmButton = modal.querySelector('[data-role="confirm-delete"]');
        const cancelButton = modal.querySelector('[data-role="cancel-delete"]');

        return new Promise((resolve) => {
            const close = (confirmed) => {
                modal.classList.remove("is-visible");
                modal.style.display = "none";
                document.body.classList.remove("modal-open");
                setPageInteractionLocked(false);
                confirmButton.removeEventListener("click", onConfirm);
                cancelButton.removeEventListener("click", onCancel);
                modal.removeEventListener("click", onBackdropClick);
                resolve(confirmed);
            };

            const onConfirm = () => close(true);
            const onCancel = () => close(false);
            const onBackdropClick = (event) => {
                if (event.target === modal) {
                    close(false);
                }
            };

            modal.classList.add("is-visible");
            modal.style.display = "flex";
            document.body.classList.add("modal-open");
            setPageInteractionLocked(true);
            confirmButton.addEventListener("click", onConfirm);
            cancelButton.addEventListener("click", onCancel);
            modal.addEventListener("click", onBackdropClick);
        });
    }

    function formatDate(dateText) {
        const date = new Date(dateText);
        if (Number.isNaN(date.getTime())) {
            return dateText || "-";
        }
        return new Intl.DateTimeFormat("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(date);
    }

    function createProjectCard(project) {
        const card = document.createElement("article");
        card.className = "card-bg card-active rounded-xl p-4 cursor-pointer group";
        card.dataset.projectId = String(project.id);

        card.addEventListener("click", () => {
            if (typeof window.focusProjectOnGlobe === "function") {
                window.focusProjectOnGlobe(project);
            }
        });

        card.innerHTML = `
            <div class="flex items-center justify-between gap-4">
                <div class="flex space-x-4 min-w-0">
                <div class="thumb-panel w-28 h-20 rounded-lg flex-shrink-0"></div>
                    <div class="min-w-0">
                        <h3 class="text-base font-semibold text-gray-100 truncate">${project.name}</h3>
                        <p class="text-[12px] text-gray-500 mt-1">创建于 ${formatDate(project.created_at)}</p>
                        <div class="mt-3 flex gap-2"><span class="label-chip">退水</span></div>
                    </div>
                </div>
                <div class="flex items-center justify-center gap-3 flex-shrink-0 self-center ml-auto">
                    <button type="button" class="action-pill action-pill--primary" data-role="open-project">打开</button>
                    <button type="button" class="action-pill action-pill--danger" data-role="delete-project">删除</button>
                </div>
            </div>
        `;

        const deleteButton = card.querySelector('[data-role="delete-project"]');
        const openButton = card.querySelector('[data-role="open-project"]');

        applyPillButtonStyle(openButton, "primary");
        applyPillButtonStyle(deleteButton, "danger");

        openButton.addEventListener("click", (event) => {
            event.stopPropagation();
            if (typeof window.focusProjectOnGlobe === "function") {
                window.focusProjectOnGlobe(project);
            }
        });

        deleteButton.addEventListener("click", async (event) => {
            event.stopPropagation();

            const confirmed = await openDeleteModal(project);
            if (!confirmed) {
                return;
            }

            try {
                await deleteProject(project.id);
                const nextProjects = (window.projectCardsData || []).filter((item) => item.id !== project.id);
                updateProjectState(nextProjects);
                await renderProjectCards();
            } catch (error) {
                console.error(error);
                window.alert("删除失败，请稍后重试。");
            }
        });

        return card;
    }

    async function fetchProjects() {
        const response = await fetch(CARDS_API, { headers: { Accept: "application/json" } });
        if (!response.ok) {
            throw new Error(`Failed to fetch project cards: ${response.status}`);
        }
        return response.json();
    }

    async function renderProjectCards() {
        const container = document.getElementById("projectCardList");
        if (!container) {
            return;
        }

        container.innerHTML = "";

        try {
            const projects = await fetchProjects();
            updateProjectState(projects);

            if (!Array.isArray(projects) || projects.length === 0) {
                container.innerHTML = '<p class="text-xs text-gray-300 border border-gray-800 rounded-lg px-3 py-2">当前项目库为空，请先执行入库脚本。</p>';
                return;
            }
            projects.forEach((project) => {
                container.appendChild(createProjectCard(project));
            });
        } catch (error) {
            console.error(error);
            updateProjectState([]);
            container.innerHTML = `
                <article class="card-bg rounded-xl p-4 border border-red-500/30">
                    <p class="text-xs text-red-300">项目列表加载失败，已使用兜底卡片。</p>
                </article>
            `;
            container.appendChild(createProjectCard({
                id: "fallback-shuiku",
                name: "shuiku",
                created_at: new Date().toISOString()
            }));
        }
    }

    window.renderProjectCards = renderProjectCards;

    document.addEventListener("DOMContentLoaded", () => {
        renderProjectCards().catch((error) => {
            console.error("Failed to render project cards on startup:", error);
        });
    });
})();
