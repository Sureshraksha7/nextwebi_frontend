// Flowchart.js — UPDATED (Part 1 of 3)
// Based on your original file. See original for reference. :contentReference[oaicite:1]{index=1}

// API Base URL
const API_BASE_URL = "https://nextwebi-backend.onrender.com";

// --- ZOOM/PAN STATE ---
let currentScale = parseFloat(localStorage.getItem('currentScale')) || 1.0;
const ZOOM_STEP = 0.15;
const MIN_SCALE = 0.1;
const MAX_SCALE = 3.0;

const vizWrapper = document.getElementById('tree-visualization');
const contentWrapper = document.getElementById('tree-content-wrapper');

let isZoomBarVisible = false;
const zoomBarContainer = document.getElementById('zoom-bar-container');
const zoomToggleButton = document.getElementById('zoom-toggle-button');

let isFilterPanelVisible = false;
const filterPanelContainer = document.getElementById('filter-panel-container');
const filterToggleButton = document.getElementById('filter-toggle-button');

// --- State management ---
let retryCount = 0;
const MAX_RETRIES = 5;
let nodeMap = {};
let parentMap = {};
let nodeStats = {};
let stableRootId = null;

let nodeToFocusId = null;        // when set, next render will focus this node
let preserveViewport = true;     // controls whether to restore last saved viewport after render

let renderedNodes = new Set();
let singleNodeMode = false;
let nodeElements = new Map();

// Status classes (unchanged)
const STATUS_CLASSES = {
    'Completed': { bg: 'bg-green-200', border: 'border-green-500', text: 'text-green-800', badge: 'bg-green-500 text-white' },
    'Processing': { bg: 'bg-orange-200', border: 'border-orange-500', text: 'text-orange-800', badge: 'bg-orange-500 text-white' },
    'New': { bg: 'bg-gray-100', border: 'border-gray-400', text: 'text-gray-800', badge: 'bg-gray-500 text-white' },
};
const DEFAULT_STATUS = STATUS_CLASSES['New'];
function getStatusClasses(status) { return STATUS_CLASSES[status] || DEFAULT_STATUS; }

// --- Utility Functions ---
function getStableColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = hash % 360;
    const s = 65;
    const l = 85;
    return `hsl(${h}, ${s}%, ${l}%)`;
}

function getBreadcrumbPath(nodeId) {
    const names = [];
    let currentId = nodeId;
    let guard = 0;
    while (currentId && nodeMap[currentId] && guard < 1000) {
        names.push(nodeMap[currentId].name);
        if (!parentMap[currentId]) break;
        currentId = parentMap[currentId];
        guard++;
    }
    return names.reverse().join(' > ');
}

function buildSubtreeLines(nodeId, prefix = '') {
    const node = nodeMap[nodeId];
    if (!node || !Array.isArray(node.children)) return [];
    const lines = [];
    for (const childId of node.children) {
        const child = nodeMap[childId];
        if (!child) continue;
        lines.push(prefix + '|');
        lines.push(prefix + '|–– ' + child.name);
        const childSub = buildSubtreeLines(childId, prefix + '      ');
        lines.push(...childSub);
    }
    return lines;
}

function formatTreePath(pathString) {
    const parts = pathString.split('>').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return '';
    let lines = [];
    lines.push(parts[0]);
    let prefix = '';
    for (let i = 1; i < parts.length; i++) {
        const name = parts[i];
        lines.push(prefix + '|');
        lines.push(prefix + '|–– ' + name);
        prefix += '      ';
    }
    return lines.join('\n');
}

// --- Fetch with retry ---
async function fetchWithRetry(endpoint, options = {}) {
    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
        if (!response.ok) {
            let errorMsg = `HTTP error! Status: ${response.status} for ${endpoint}.`;
            try {
                const errorData = await response.json();
                errorMsg = errorData.error || errorMsg;
            } catch (e) {}
            throw new Error(errorMsg);
        }
        retryCount = 0;
        return await response.json();
    } catch (error) {
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delay = Math.pow(2, retryCount) * 100;
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(endpoint, options);
        } else {
            showMessage(`Fatal Error: ${error.message}. Is your Flask server running? Redirecting to setup...`, 'error');
            setTimeout(() => { window.location.href = 'index.html'; }, 1000);
            throw error;
        }
    }
}

function showMessage(message, type) {
    const statusDiv = document.getElementById('status-message');
    if (!statusDiv) return;
    statusDiv.textContent = message;
    statusDiv.classList.remove('hidden', 'bg-green-100', 'text-green-800', 'bg-red-100', 'text-red-800', 'bg-blue-100', 'text-blue-800');
    if (type === 'success') statusDiv.classList.add('bg-green-100', 'text-green-800');
    else if (type === 'error') statusDiv.classList.add('bg-red-100', 'text-red-800');
    else statusDiv.classList.add('bg-blue-100', 'text-blue-800');
    setTimeout(() => statusDiv.classList.add('hidden'), 5000);
}

// --- ZOOM/PAN Functions ---
function applyZoom(scale) {
    currentScale = Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
    if (contentWrapper) contentWrapper.style.transform = `scale(${currentScale})`;
    localStorage.setItem('currentScale', currentScale.toFixed(2));
}

function zoomIn() { applyZoom(currentScale + ZOOM_STEP); }
function zoomOut() { applyZoom(currentScale - ZOOM_STEP); }

// resetZoom: removed forced left/top scroll; will optionally focus node or restore saved viewport
function resetZoom() {
    if (!contentWrapper || !vizWrapper) {
        applyZoom(1.0);
        return;
    }
    const contentWidth = contentWrapper.scrollWidth;
    const containerWidth = vizWrapper.clientWidth;
    const scaleFactor = Math.min(1.0, (containerWidth - 50) / contentWidth);
    applyZoom(scaleFactor);

    // Do not force scrollLeft = 0 anymore.
    // If there is a nodeToFocusId, focus it; otherwise restore last saved viewport (if present).
    if (nodeToFocusId) {
        // focusNode will smooth-scroll into view
        setTimeout(() => focusNode(nodeToFocusId), 120);
        nodeToFocusId = null;
        return;
    }

    // Try restore saved viewport if present
    const saved = localStorage.getItem('lastViewport');
    if (saved) {
        try {
            const vp = JSON.parse(saved);
            setTimeout(() => {
                try { vizWrapper.scrollTo({ left: vp.left, top: vp.top, behavior: 'smooth' }); } catch(e) {}
            }, 120);
        } catch(e) { /* ignore */ }
    }
}

function toggleZoomBar() {
    isZoomBarVisible = !isZoomBarVisible;
    if (isZoomBarVisible) {
        zoomBarContainer.classList.remove('hidden', 'translate-x-full'); zoomBarContainer.classList.add('translate-x-0');
        zoomToggleButton.innerHTML = '<svg data-lucide="minimize" width="20" height="20"></svg>';
    } else {
        zoomBarContainer.classList.remove('translate-x-0'); zoomBarContainer.classList.add('translate-x-full');
        setTimeout(() => { zoomBarContainer.classList.add('hidden'); }, 300);
        zoomToggleButton.innerHTML = '<svg data-lucide="maximize" width="20" height="20"></svg>';
    }
    window.lucide.createIcons();
}
// Flowchart.js — UPDATED (Part 2 of 3)

// NEW FUNCTION: Focus/Center the view on a specific node
function focusNode(nodeId) {
    if (!nodeId) return;
    const targetElement = document.getElementById(`node-${nodeId}`);
    if (!targetElement) {
        console.warn(`Node element with ID node-${nodeId} not found for focusing.`);
        return;
    }

    // Use small delay to ensure layout is stable
    setTimeout(() => {
        const nodeCenterX = (targetElement.offsetLeft + (targetElement.offsetWidth / 2));
        const nodeCenterY = (targetElement.offsetTop + (targetElement.offsetHeight / 2));

        const targetScrollLeft = nodeCenterX * currentScale - (vizWrapper.clientWidth / 2);
        const targetScrollTop = nodeCenterY * currentScale - (vizWrapper.clientHeight / 2) + 100;

        try {
            vizWrapper.scrollTo({ top: targetScrollTop, left: targetScrollLeft, behavior: 'smooth' });
        } catch (e) {
            vizWrapper.scrollLeft = Math.max(0, targetScrollLeft);
            vizWrapper.scrollTop = Math.max(0, targetScrollTop);
        }

        // Brief highlight
        targetElement.classList.add('shadow-outline', 'ring-4', 'ring-blue-500', 'ring-opacity-70', 'transition-all', 'duration-500');
        setTimeout(() => {
            targetElement.classList.remove('shadow-outline', 'ring-4', 'ring-blue-500', 'ring-opacity-70', 'transition-all', 'duration-500');
        }, 1400);
    }, 120);
}

// --- Filter Panel Functions ---
function toggleFilterPanel() {
    isFilterPanelVisible = !isFilterPanelVisible;
    if (isFilterPanelVisible) { filterPanelContainer.classList.remove('-translate-x-full'); filterPanelContainer.classList.add('translate-x-0'); }
    else { filterPanelContainer.classList.remove('translate-x-0'); filterPanelContainer.classList.add('-translate-x-full'); }
    window.lucide.createIcons();
}

function isNodeVisible(nodeId) {
    const node = nodeMap[nodeId];
    if (!node) return false;
    if (node._forceVisible) return true;

    const connectionFilter = document.getElementById('connection-filter-select')?.value;
    const stats = nodeStats[nodeId];
    if (stats) {
        if (connectionFilter === 'inbound' && stats.inboundCount === 0) return false;
        if (connectionFilter === 'outbound' && stats.outboundCount === 0) return false;
    }

    const statusFilterEl = document.getElementById('status-filter-select');
    if (statusFilterEl) {
        const statusFilter = statusFilterEl.value;
        if (statusFilter !== 'all' && node.status !== statusFilter) return false;
    }

    return true;
}

// Link and description helpers (unchanged)
function getFirstUrl(text) {
    if (!text) return null;
    const urlRegex = /(https?:\/\/[^\s]+)/;
    const match = text.match(urlRegex);
    return match ? match[1] : null;
}
function linkifyDescription(text) {
    if (!text) return "";
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, (url) => {
        const safeUrl = url.replace(/"/g, "&quot;");
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline">${url}</a>`;
    });
}

// updateParentContainer: (unchanged logic, ensures children container exists)
function updateParentContainer(parentId) {
    if (!parentId) return;
    const parentNode = nodeMap[parentId];
    if (!parentNode || !parentNode.children || parentNode.children.length === 0) {
        const parentElement = document.getElementById(`node-${parentId}`);
        if (parentElement) {
            const parentWrapper = parentElement.closest('.node-wrapper');
            if (parentWrapper) {
                const existingContainer = parentWrapper.querySelector('.tree-container');
                if (existingContainer) { existingContainer.remove(); }
            }
        }
        return;
    }

    const parentElement = document.getElementById(`node-${parentId}`);
    if (!parentElement) return;
    const parentWrapper = parentElement.closest('.node-wrapper');
    if (!parentWrapper) return;

    let container = parentWrapper.querySelector('.tree-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'tree-container' + (parentNode.children.length === 1 ? ' single-child-container' : '');
        parentWrapper.appendChild(container);
    } else { container.innerHTML = ''; }

    parentNode.children.forEach(childId => {
        if (nodeMap[childId]) {
            const childHtml = renderNode(childId, nodeMap, 1);
            container.insertAdjacentHTML('beforeend', childHtml);
        }
    });

    window.lucide.createIcons();
}

// applyFilters: updated to set nodeToFocusId when a single match is found
async function applyFilters() {
    const nameInput = document.getElementById('search-filter-input');
    const idInput = document.getElementById('search-id-input');
    const connectionFilter = document.getElementById('connection-filter-select')?.value;
    const vizWrap = document.getElementById('tree-content-wrapper');

    const nameQ = nameInput ? nameInput.value.trim().toLowerCase() : '';
    const idQ = idInput ? idInput.value.trim().toLowerCase() : '';

    // Search by name/description or friendly ID
    if (nameQ.length >= 2 || idQ.length >= 1) {
        let foundNodeId = null;
        for (const id in nodeMap) {
            const node = nodeMap[id];
            let matchesName = true;
            if (nameQ.length >= 2) {
                matchesName = (node.name || '').toLowerCase().includes(nameQ) || (node.description || '').toLowerCase().includes(nameQ);
            }
            let matchesId = true;
            if (idQ.length >= 1) {
                matchesId = (node.friendlyId || '').toLowerCase().includes(idQ);
            }
            if (matchesName && matchesId) { foundNodeId = id; break; }
        }

        if (foundNodeId) {
            singleNodeMode = true;
            nodeToFocusId = foundNodeId; // focus the filtered result node
            preserveViewport = false;     // we want the focus behavior
            loadAndRenderVisuals(foundNodeId);
            const n = nodeMap[foundNodeId];
            showMessage(`Displaying only: ${n.name} (ID ${n.friendlyId || ''})`, 'info');
            return;
        } else {
            singleNodeMode = false;
            vizWrap.innerHTML = '<p class="text-center text-gray-500 italic p-10">No node found matching your search.</p>';
            return;
        }
    }

    // For IN/OUT filters: ensure stats are loaded
    if (connectionFilter === 'inbound' || connectionFilter === 'outbound') {
        await fetchAllStats();
    }

    const rootId = stableRootId || Object.keys(nodeMap)[0] || null;
    if (!rootId) {
        vizWrap.innerHTML = '<p class="text-center text-gray-500 italic p-10">No nodes to display.</p>';
        return;
    }

    singleNodeMode = false;
    preserveViewport = true; // keep viewport unless a specific focus is requested
    loadAndRenderVisuals(rootId);
}

// fetchAllStats: cleaned up to rely on fetchWithRetry parsing and robust handling
async function fetchAllStats() {
    try {
        const allStats = await fetchWithRetry('/stats/all');
        nodeStats = {};
        if (allStats && typeof allStats === 'object') {
            Object.entries(allStats).forEach(([nodeId, stats]) => {
                nodeStats[nodeId] = {
                    inboundCount: stats.total_inbound_count || 0,
                    outboundCount: stats.total_outbound_count || 0
                };
            });
        } else {
            console.warn('Unexpected stats format:', allStats);
        }
        return nodeStats;
    } catch (e) {
        console.error('Error in fetchAllStats:', e);
        nodeStats = {};
        return nodeStats;
    }
}

// handleEditSubmit: already sets nodeToFocusId; ensure preserveViewport=false so focus happens
async function handleEditSubmit(e) {
    e.preventDefault();
    const contentId = document.getElementById('edit-content-id').value;
    const newName = document.getElementById('edit-name').value.trim();
    const newDescription = document.getElementById('edit-description').value.trim();
    const newStatus = document.getElementById('edit-status').value;
    closeEditModal();
    try {
        const options = {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName, description: newDescription, status: newStatus })
        };
        await fetchWithRetry(`/node/update/${encodeURIComponent(contentId)}`, options);

        showMessage(`Node updated to '${newName}' (Status: ${newStatus}).`, 'success');

        nodeMap[contentId].name = newName;
        nodeMap[contentId].description = newDescription;
        nodeMap[contentId].status = newStatus;

        nodeToFocusId = contentId;
        preserveViewport = false;
        loadAndRenderVisuals(stableRootId);
    } catch (error) {
        showMessage(`Failed to update node: ${error.message}`, 'error');
        loadAndRenderTree();
    }
}
// Flowchart.js — UPDATED (Part 3 of 3)

// deleteNode: ensure after deletion we focus the parent (if exists) or fallback to root
async function deleteNode(contentId, name) {
    if (!confirm(`Are you sure you want to delete "${name}"? This action cannot be undone.`)) {
        return;
    }
    closeDeleteConfirmModal();

    try {
        const parentId = parentMap[contentId] || null;

        // 1) Delete on server
        await fetchWithRetry(`/node/delete/${encodeURIComponent(contentId)}`, { method: 'DELETE' });

        // 2) Update local maps
        if (parentId && nodeMap[parentId] && Array.isArray(nodeMap[parentId].children)) {
            nodeMap[parentId].children = nodeMap[parentId].children.filter(id => id !== contentId);
        }
        delete nodeMap[contentId];
        delete parentMap[contentId];

        // 3) Set focus to parent (or root) and reload
        nodeToFocusId = parentId || stableRootId || null;
        preserveViewport = false;
        await loadAndRenderTree();

        showMessage(`Node "${name}" deleted successfully.`, 'success');
    } catch (error) {
        console.error('Error deleting node:', error);
        showMessage(`Failed to delete node: ${error.message}`, 'error');
        location.reload();
    }
}

// openInboundDetails & openOutboundDetails unchanged (kept from your original file)
// ... (they are present earlier in your original code and unchanged) ...

function applyStatColors(nodeId) {
    const stats = nodeStats[nodeId] || { inboundCount: 0, outboundCount: 0 };
    const inboundEl = document.getElementById(`inbound-stat-${nodeId}`);
    const outboundEl = document.getElementById(`outbound-stat-${nodeId}`);
    if (inboundEl) inboundEl.className = 'inbound-stat ml-1 ' + (stats.inboundCount > 0 ? 'text-green-600 font-bold' : 'text-gray-500');
    if (outboundEl) outboundEl.className = 'outbound-stat ml-1 ' + (stats.outboundCount > 0 ? 'text-red-600 font-bold' : 'text-gray-500');
}

function updateNodeStats(nodeId) {
    const stats = nodeStats[nodeId] || { inboundCount: 0, outboundCount: 0 };
    const hasInbound = stats.inboundCount > 0;
    const hasOutbound = stats.outboundCount > 0;
    const statsDiv = document.getElementById(`stats-${nodeId}`);
    if (statsDiv) {
        statsDiv.innerHTML = `
            <div class="flex justify-around text-xs font-bold pt-1 border-t border-gray-300 mt-1">
                <button type="button" class="text-gray-700 focus:outline-none" onclick="openInboundDetails('${nodeId}')">
                    IN:
                    <span id="inbound-stat-${nodeId}" class="inbound-stat ${hasInbound ? 'inbound-active' : 'inbound-inactive'}">
                        ${stats.inboundCount}
                    </span>
                </button>
                <button type="button" class="text-gray-700 focus:outline-none" onclick="openOutboundDetails('${nodeId}')">
                    OUT:
                    <span id="outbound-stat-${nodeId}" class="outbound-stat ${hasOutbound ? 'outbound-active' : 'outbound-inactive'}">
                        ${stats.outboundCount}
                    </span>
                </button>
            </div>
        `;
    }
}

function updateVisibleNodeStats() {
    document.querySelectorAll('[id^="node-"]').forEach(nodeElement => {
        const nodeId = nodeElement.id.replace('node-', '');
        updateNodeStats(nodeId);
    });
}

// loadAndRenderVisuals: updated to respect nodeToFocusId and preserveViewport/localStorage restore
async function loadAndRenderVisuals(rootOverrideId = null) {
    const vizWrap = document.getElementById('tree-content-wrapper');
    if (!vizWrap) return;
    renderedNodes.clear();
    vizWrap.innerHTML = '<p class="text-center text-gray-500 italic p-10">Rendering tree...</p>';

    // Mark parents visible for any visible nodes
    const markParentsVisible = (nodeId) => {
        let currentId = nodeId;
        while (parentMap[currentId]) {
            const parentId = parentMap[currentId];
            if (!nodeMap[parentId]) break;
            nodeMap[parentId]._forceVisible = true;
            currentId = parentId;
        }
    };
    for (const nodeId in nodeMap) { if (isNodeVisible(nodeId)) markParentsVisible(nodeId); }

    let rootNodeId = rootOverrideId || stableRootId || Object.keys(nodeMap)[0];
    if (!rootNodeId || !nodeMap[rootNodeId]) {
        if (stableRootId) loadAndRenderTree();
        return;
    }

    try {
        await fetchAllStats();
        const treeHtml = renderNode(rootNodeId, nodeMap, 0);
        vizWrap.innerHTML = treeHtml;
        window.lucide.createIcons();

        // apply zoom
        applyZoom(currentScale);

        // If a specific node is requested to focus, do it. Otherwise, restore viewport
        if (nodeToFocusId) {
            setTimeout(() => focusNode(nodeToFocusId), 150);
            nodeToFocusId = null;
        } else if (preserveViewport) {
            // restore last saved viewport (if any)
            const saved = localStorage.getItem('lastViewport');
            if (saved) {
                try {
                    const vp = JSON.parse(saved);
                    setTimeout(() => {
                        try { vizWrapper.scrollTo({ left: vp.left, top: vp.top, behavior: 'auto' }); } catch (e) { vizWrapper.scrollLeft = vp.left; vizWrapper.scrollTop = vp.top; }
                    }, 80);
                } catch(e) {}
            }
        }

        // update stats for visible nodes
        updateVisibleNodeStats();
        setTimeout(updateHorizontalLines, 100);

        // cleanup temp flags
        for (const nodeId in nodeMap) delete nodeMap[nodeId]._forceVisible;
    } catch (error) {
        console.error("Error in loadAndRenderVisuals:", error);
        vizWrap.innerHTML = '<p class="text-center text-red-500 italic p-10">Error rendering tree. Please try refreshing the page.</p>';
    }
}

// renderNode (keeps your original structure, but respects _forceVisible and schedules stats update)
function renderNode(nodeId, nodeMapLocal, level = 0) {
    const node = nodeMapLocal[nodeId];
    if (!node) return '';
    if (!node._forceVisible && !isNodeVisible(nodeId)) return '';
    if (renderedNodes.has(nodeId)) return '';
    renderedNodes.add(nodeId);

    const nodeName = node.name;
    const nodeIdStr = node.contentId;
    const friendlyId = node.friendlyId || '';
    const statusClasses = getStatusClasses(node.status);

    const stats = nodeStats[nodeId] || { inboundCount: 0, outboundCount: 0 };
    const hasInbound = stats.inboundCount > 0;
    const hasOutbound = stats.outboundCount > 0;

    const sortedChildren = (node.children || []).slice().sort();
    const hasChildren = sortedChildren.length > 0;

    // schedule stat update
    setTimeout(() => updateNodeStats(nodeId), 100);

    // children
    let childrenHtml = '';
    if (hasChildren && !(singleNodeMode && level === 0)) {
        const childNodesHtml = sortedChildren
            .map(childId => renderNode(childId, nodeMapLocal, level + 1))
            .join('');
        if (childNodesHtml.trim() !== '') {
            const containerClass = sortedChildren.length === 1 ? ' single-child-container' : '';
            childrenHtml = `<div class="tree-container${containerClass}">${childNodesHtml}</div>`;
        }
    }

    // action icons
    let actionIcons = '';
    const iconStyle = `width="12" height="12" class="text-gray-800" stroke-width="2.5"`;

    actionIcons += `
        <button class="info-btn" onclick="openInfoModal('${nodeIdStr}')" title="View Description/Stats">
            <svg data-lucide="info" ${iconStyle}></svg>
        </button>
        <button class="edit-btn" onclick="openEditModal('${nodeIdStr}')" title="Edit Node Details">
            <svg data-lucide="pencil" ${iconStyle}></svg>
        </button>
        <button class="search-btn" onclick="openSearchLinkModal('${nodeIdStr}', '${nodeName}')" title="Search & Link Nodes">
            <svg data-lucide="search" ${iconStyle}></svg>
        </button>
    `;

    const firstUrl = getFirstUrl(node.description);
    if (firstUrl) {
        const safeUrl = firstUrl.replace(/"/g, '&quot;');
        actionIcons += `
            <button class="link-btn" onclick="window.open('${safeUrl}', '_blank')" title="Open link from description">
                <svg data-lucide="link" width="12" height="12" class="text-blue-600" stroke-width="2.5"></svg>
            </button>
        `;
    }

    if ((node.children || []).length === 0) {
        actionIcons += `
            <button class="delete-btn" onclick="openDeleteConfirmModal('${nodeIdStr}')" title="Delete Node">
                <svg data-lucide="trash-2" width="12" height="12" class="text-red-600" stroke-width="2.5"></svg>
            </button>
        `;
    }

    actionIcons += `
        <button class="add-child-btn" onclick="openChildModal('${nodeIdStr}', '${nodeName}')" title="Add New Child">
            <svg data-lucide="plus" ${iconStyle}></svg>
        </button>
    `;

    const statsHtml = `
        <div id="stats-${nodeIdStr}" class="p-0.5">
            <div class="flex justify-around text-xs font-bold pt-1 border-t border-gray-300 mt-1">
                <button type="button" class="text-gray-700 focus:outline-none" onclick="openInboundDetails('${nodeIdStr}')">
                    IN:
                    <span id="inbound-stat-${nodeIdStr}" class="inbound-stat ${hasInbound ? 'inbound-active' : 'inbound-inactive'}">
                        ${stats.inboundCount}
                    </span>
                </button>
                <button type="button" class="text-gray-700 focus:outline-none" onclick="openOutboundDetails('${nodeIdStr}')">
                    OUT:
                    <span id="outbound-stat-${nodeIdStr}" class="outbound-stat ${hasOutbound ? 'outbound-active' : 'outbound-inactive'}">
                        ${stats.outboundCount}
                    </span>
                </button>
            </div>
        </div>
    `;

    const wrapperClass = hasChildren ? 'node-wrapper has-children' : 'node-wrapper';
    const levelColor = getLevelColor(level);

    return `
        <div class="${wrapperClass}" style="--line-color: ${levelColor};">
            <div class="node-card ${statusClasses.bg} p-2 rounded-xl border ${statusClasses.border} shadow-lg node-box relative" id="node-${nodeIdStr}">
                <div class="absolute top-1 left-2 text-[9px] font-semibold text-gray-500">${friendlyId}</div>
                <div class="node-action-bar">${actionIcons}</div>
                <h3 class="text-xs ${statusClasses.text} pl-4 pr-4 whitespace-normal text-center">${nodeName}</h3>
                <p class="text-[7px] text-gray-600 pl-4 pr-4">Status: ${node.status}</p>
                <p class="text-[7px] text-gray-600 pl-4 pr-4">ID: <span class="font-mono">${nodeIdStr.substring(0, 8)}...</span></p>
                ${statsHtml}
            </div>
            ${childrenHtml}
        </div>
    `;
}

// loadAndRenderTree: fetches /tree, rebuilds nodeMap & parentMap and renders; restores viewport/focus per rules
async function loadAndRenderTree() {
    const vizWrap = document.getElementById('tree-content-wrapper');
    if (!vizWrap) return;
    vizWrap.innerHTML = '<div class="flex justify-center items-center h-full"><div class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div></div>';

    try {
        renderedNodes.clear();
        nodeMap = {};
        parentMap = {};

        const response = await fetchWithRetry('/tree');
        if (!response || response.length === 0) {
            vizWrap.innerHTML = '<p class="text-center text-red-500 italic p-10">No Root Node found. <a href="index.html" class="text-indigo-600 font-semibold hover:underline">Click here to create the root node.</a></p>';
            return;
        }

        response.forEach(node => { nodeMap[node.contentId] = { ...node }; });
        response.forEach(node => {
            if (Array.isArray(node.children)) {
                node.children.forEach(childId => {
                    if (childId && nodeMap[childId]) parentMap[childId] = node.contentId;
                });
            }
        });

        assignFriendlyIds(response);
        updateTotalNodeCount();

        const rootNodeId = response[0]?.contentId;
        if (!rootNodeId) throw new Error('No root node found');
        stableRootId = rootNodeId;

        await fetchAllStats();

        const treeHtml = renderNode(rootNodeId, nodeMap, 0);
        vizWrap.innerHTML = treeHtml;
        window.lucide.createIcons();

        applyZoom(currentScale);

        // If a node to focus exists (set by actions), focus it. Otherwise restore viewport
        if (nodeToFocusId) {
            setTimeout(() => focusNode(nodeToFocusId), 150);
            nodeToFocusId = null;
        } else if (preserveViewport) {
            const saved = localStorage.getItem('lastViewport');
            if (saved) {
                try {
                    const vp = JSON.parse(saved);
                    setTimeout(() => {
                        try { vizWrapper.scrollTo({ left: vp.left, top: vp.top, behavior: 'auto' }); } catch(e) { vizWrapper.scrollLeft = vp.left; vizWrapper.scrollTop = vp.top; }
                    }, 80);
                } catch(e) {}
            }
        }

        updateVisibleNodeStats();
        setTimeout(updateHorizontalLines, 100);
    } catch (error) {
        console.error("Tree loading failed:", error);
        vizWrap.innerHTML = `
            <div class="text-center p-10">
                <p class="text-red-500 font-medium">Error loading tree:</p>
                <p class="text-gray-600 text-sm mt-2">${error.message}</p>
                <button onclick="loadAndRenderTree()" class="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors">Retry</button>
            </div>
        `;
    }
}

// assignFriendlyIds unchanged
function assignFriendlyIds(orderArray = null) {
    let nodesInOrder;
    if (orderArray && Array.isArray(orderArray)) {
        nodesInOrder = orderArray.map(n => nodeMap[n.contentId]).filter(Boolean);
    } else {
        nodesInOrder = Object.values(nodeMap || {});
    }
    if (!nodesInOrder.length) return;
    let counter = 1;
    nodesInOrder.forEach(node => { node.friendlyId = String(counter).padStart(2, '0'); counter += 1; });
}

// updateHorizontalLines unchanged
function updateHorizontalLines() {
    document.querySelectorAll(".tree-container").forEach(container => {
        const children = container.children;
        if (children.length < 2) return;
        const firstChild = children[0];
        const lastChild = children[children.length - 1];
        const start = firstChild.offsetLeft + (firstChild.offsetWidth / 2);
        const end   = lastChild.offsetLeft  + (lastChild.offsetWidth  / 2);
        container.style.setProperty("--line-start", start + "px");
        container.style.setProperty("--line-end",   end   + "px");
    });
}

function getLevelColor(level) {
    const hue = (level * 57 + 137) % 360;
    const saturation = 55;
    const lightness = 70;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

// DOMContentLoaded: attach listeners, save/restore viewport positions
document.addEventListener('DOMContentLoaded', () => {
    // Save viewport position on scroll so it can be restored on reloads
    const safeViz = document.getElementById('tree-visualization');
    if (safeViz) {
        safeViz.addEventListener('scroll', () => {
            try {
                const snapshot = { left: safeViz.scrollLeft, top: safeViz.scrollTop, scale: currentScale };
                localStorage.setItem('lastViewport', JSON.stringify(snapshot));
            } catch(e) {}
        }, { passive: true });
    }

    // create child form submit handler (keeps original logic but sets nodeToFocusId & preserveViewport)
    document.getElementById('create-child-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const parentId = document.getElementById('modal-parent-id').value;
        const parentName = nodeMap[parentId]?.name || 'Parent';
        const childName = document.getElementById('child-name').value.trim();
        const childDescription = document.getElementById('child-description').value.trim();
        if (!childName) { showMessage('Please enter a name for the new node', 'error'); return; }
        closeChildModal();
        try {
            const vizWrap = document.getElementById('tree-content-wrapper');
            vizWrap.innerHTML = '<div class="flex justify-center items-center h-full"><div class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div></div>';
            showMessage(`Creating node '${childName}'...`, 'info');
            const nodeOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: childName, description: childDescription, status: 'New' })};
            const childResult = await fetchWithRetry('/node/create', nodeOptions);
            const childId = childResult.contentId;
            if (!childId) throw new Error('Failed to create node: No ID returned');

            showMessage(`Linking '${parentName}' to '${childName}'...`, 'info');
            const relationOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentId, childId }) };
            await fetchWithRetry('/relation/create', relationOptions);

            document.getElementById('child-name').value = '';
            document.getElementById('child-description').value = '';

            nodeMap[childId] = { contentId: childId, name: childName, description: childDescription, status: 'New', children: [] };
            parentMap[childId] = parentId;
            if (nodeMap[parentId]) {
                if (!nodeMap[parentId].children) nodeMap[parentId].children = [];
                nodeMap[parentId].children.push(childId);
            }

            // Render just the parent container if possible, else reload full tree
            const parentElement = document.getElementById(`node-${parentId}`);
            if (parentElement) {
                const parentWrapper = parentElement.closest('.node-wrapper');
                if (parentWrapper) {
                    // Update the children container for the parent
                    updateParentContainer(parentId);

                    // Ensure we focus the new node
                    nodeToFocusId = childId;
                    preserveViewport = false;
                    // small delay to allow DOM insertion
                    setTimeout(() => focusNode(childId), 200);
                } else {
                    nodeToFocusId = childId;
                    preserveViewport = false;
                    await loadAndRenderTree();
                }
            } else {
                nodeToFocusId = childId;
                preserveViewport = false;
                await loadAndRenderTree();
            }
            showMessage(`Successfully created '${childName}'`, 'success');
        } catch (error) {
            console.error('Error creating node:', error);
            showMessage(`Failed to create node: ${error.message}`, 'error');
            try { await loadAndRenderTree(); } catch(e) { console.error('Reload failed after create error:', e); }
        }
    });

    // other UI bindings (re-attach existing handlers)
    document.getElementById('edit-node-form').addEventListener('submit', handleEditSubmit);
    document.getElementById('modal-cancel-child').addEventListener('click', closeChildModal);
    document.getElementById('start-search-button').addEventListener('click', handleSearch);
    document.getElementById('confirm-link-button').addEventListener('click', handleLinkSelected);
    document.getElementById('search-input').addEventListener('keypress', function(e) { if (e.key === 'Enter') { e.preventDefault(); handleSearch(); } });

    // Initial load
    loadAndRenderTree();
});

// expose needed functions globally
window.zoomIn = zoomIn; window.zoomOut = zoomOut; window.resetZoom = resetZoom; window.toggleZoomBar = toggleZoomBar;
window.toggleFilterPanel = toggleFilterPanel; window.applyFilters = applyFilters; window.openInfoModal = openInfoModal;
window.closeInfoModal = closeInfoModal;
window.openEditModal = openEditModal;
window.closeEditModal = closeEditModal;
window.openDeleteConfirmModal = openDeleteConfirmModal; window.closeDeleteConfirmModal = closeDeleteConfirmModal;
window.openChildModal = openChildModal; window.closeChildModal = closeChildModal; window.openSearchLinkModal = openSearchLinkModal;
window.closeSearchLinkModal = closeSearchLinkModal; window.deleteRelationFromModal = deleteRelationFromModal;
window.loadAndRenderVisuals = loadAndRenderVisuals; window.openInboundDetails = openInboundDetails; window.openOutboundDetails = openOutboundDetails;
window.stableRootId = stableRootId;
