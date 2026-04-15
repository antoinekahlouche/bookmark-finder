"use strict";

const state = {
  rootId: null,
  nodes: new Map(),
  folderPath: [],
  selectedId: null,
  activeParentId: null,
  contextMenuNodeId: null,
  editorNodeId: null,
  editorMode: null,
  deleteNodeId: null,
};

const elements = {
  columns: document.getElementById("columns"),
  contextMenu: document.getElementById("context-menu"),
  editorBackdrop: document.getElementById("editor-backdrop"),
  editorForm: document.getElementById("editor-form"),
  editorTitle: document.getElementById("editor-title"),
  editorName: document.getElementById("editor-name"),
  editorUrlField: document.getElementById("editor-url-field"),
  editorUrl: document.getElementById("editor-url"),
  editorError: document.getElementById("editor-error"),
  editorCancel: document.getElementById("editor-cancel"),
  deleteBackdrop: document.getElementById("delete-backdrop"),
  deleteTitle: document.getElementById("delete-title"),
  deleteMessage: document.getElementById("delete-message"),
  deleteError: document.getElementById("delete-error"),
  deleteCancel: document.getElementById("delete-cancel"),
  deleteConfirm: document.getElementById("delete-confirm"),
  columnTemplate: document.getElementById("column-template"),
  rowTemplate: document.getElementById("row-template"),
};

const bookmarkEvents = [
  "onCreated",
  "onRemoved",
  "onChanged",
  "onMoved",
  "onChildrenReordered",
  "onImportEnded",
];

let refreshTimer = null;

initialize();

function initialize() {
  elements.columns.addEventListener("keydown", handleKeydown);
  elements.editorForm.addEventListener("submit", handleEditorSubmit);
  elements.editorCancel.addEventListener("click", closeEditor);
  elements.editorBackdrop.addEventListener("mousedown", handleEditorBackdropMouseDown);
  elements.deleteCancel.addEventListener("click", closeDeleteDialog);
  elements.deleteConfirm.addEventListener("click", handleDeleteConfirm);
  elements.deleteBackdrop.addEventListener("mousedown", handleDeleteBackdropMouseDown);
  document.addEventListener("mousedown", handleDocumentMouseDown);
  document.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("resize", closeContextMenu);

  for (const eventName of bookmarkEvents) {
    chrome.bookmarks[eventName].addListener(queueRefresh);
  }

  loadBookmarks();
}

async function loadBookmarks() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const root = tree[0];
    const previousSelection = state.selectedId;
    const previousPath = [...state.folderPath];
    const previousActiveParent = state.activeParentId;

    state.nodes.clear();
    indexNode(root, null);
    state.rootId = root.id;
    state.folderPath = previousPath.filter((id) => {
      const node = state.nodes.get(id);
      return Boolean(node && isFolder(node));
    });
    state.selectedId = state.nodes.has(previousSelection) ? previousSelection : null;
    state.activeParentId = state.nodes.has(previousActiveParent) ? previousActiveParent : state.rootId;

    if (state.selectedId) {
      alignPathToSelection();
    } else {
      applyDefaultSelection(root);
    }

    render();
  } catch (error) {
    showError(error);
  }
}

function indexNode(node, parentId) {
  const normalizedNode = {
    ...node,
    parentId,
    children: Array.isArray(node.children) ? node.children : [],
  };

  state.nodes.set(node.id, normalizedNode);

  for (const child of normalizedNode.children) {
    indexNode(child, node.id);
  }
}

function applyDefaultSelection(root) {
  const defaultFolder = getDefaultRootFolder(root);

  if (!defaultFolder) {
    state.folderPath = [];
    state.selectedId = null;
    state.activeParentId = state.rootId;
    return;
  }

  state.folderPath = buildFolderPath(defaultFolder.id);
  state.selectedId = defaultFolder.id;
  state.activeParentId = defaultFolder.id;
}

function getDefaultRootFolder(root) {
  if (!root?.children?.length) {
    return null;
  }

  return (
    root.children.find((node) => isFolder(node) && /^bookmarks bar$/i.test(node.title)) ||
    root.children.find((node) => isFolder(node)) ||
    null
  );
}

function render() {
  const columns = getVisibleColumns();
  const fragment = document.createDocumentFragment();

  for (const column of columns) {
    const columnNode = elements.columnTemplate.content.firstElementChild.cloneNode(true);
    const itemsContainer = columnNode.querySelector(".column-items");
    const selectedChildId = getSelectedChildId(column.parentId);

    itemsContainer.dataset.parentId = column.parentId;
    itemsContainer.tabIndex = column.parentId === state.activeParentId ? 0 : -1;

    if (column.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Empty folder";
      itemsContainer.append(empty);
    }

    for (const item of column.items) {
      const row = createRow(item, column.parentId, item.id === selectedChildId, column.parentId === state.activeParentId);
      itemsContainer.append(row);
    }

    fragment.append(columnNode);
  }

  elements.columns.replaceChildren(fragment);
  focusActiveColumn();
  scrollSelectionIntoView();
}

function getVisibleColumns() {
  const root = state.nodes.get(state.rootId);
  const columns = [
    {
      parentId: state.rootId,
      items: root ? root.children : [],
    },
  ];

  for (const folderId of state.folderPath) {
    const folder = state.nodes.get(folderId);

    if (!folder || !isFolder(folder)) {
      continue;
    }

    columns.push({
      parentId: folder.id,
      items: folder.children,
    });
  }

  return columns;
}

function createRow(item, parentId, isSelected, isActiveColumn) {
  const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
  const label = row.querySelector(".row-label");
  const favicon = row.querySelector(".row-favicon");
  const icon = row.querySelector(".row-icon");
  let pointerHandled = false;

  row.dataset.id = item.id;
  row.dataset.parentId = parentId;
  row.dataset.kind = isFolder(item) ? "folder" : "bookmark";
  row.classList.toggle("selected", isSelected);
  row.classList.toggle("active-selection", isSelected && isActiveColumn);
  row.classList.toggle("keyboard-focus", isSelected && isActiveColumn);
  row.setAttribute("aria-selected", String(isSelected));
  label.textContent = getNodeTitle(item);
  row.title = buildTooltip(item);

  favicon.hidden = true;
  icon.hidden = false;

  if (item.url) {
    favicon.src = getFaviconUrl(item.url);
    favicon.hidden = false;
    icon.hidden = true;
    favicon.addEventListener(
      "error",
      () => {
        favicon.hidden = true;
        icon.hidden = false;
      },
      { once: true }
    );
  }

  row.addEventListener("mousedown", (event) => {
    if (event.metaKey || event.ctrlKey || event.button === 1) {
      event.preventDefault();
    }
  });

  row.addEventListener("mouseup", (event) => {
    if (event.button !== 0) {
      return;
    }

    pointerHandled = true;
    event.preventDefault();
    event.stopPropagation();

    const useNewTab = event.metaKey || event.ctrlKey;
    handleRowAction(item.id, parentId, useNewTab);
  });

  row.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (pointerHandled) {
      pointerHandled = false;
      return;
    }

    const useNewTab = event.metaKey || event.ctrlKey;
    handleRowAction(item.id, parentId, useNewTab);
  });

  row.addEventListener("auxclick", (event) => {
    if (event.button !== 1) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleRowAction(item.id, parentId, true);
  });

  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(item.id, parentId, event.clientX, event.clientY);
  });

  return row;
}

function handleRowAction(nodeId, parentId, useNewTab) {
  const node = state.nodes.get(nodeId);

  if (!node) {
    return;
  }

  state.activeParentId = parentId;

  if (isFolder(node)) {
    if (useNewTab) {
      openFolderBookmarks(node);
      return;
    }

    openFolder(node.id);
    return;
  }

  state.selectedId = node.id;
  render();
  openBookmark(node, useNewTab);
}

function openFolder(folderId) {
  const folder = state.nodes.get(folderId);

  if (!folder || !isFolder(folder)) {
    return;
  }

  state.folderPath = buildFolderPath(folderId);
  state.selectedId = folderId;
  state.activeParentId = folder.id;
  render();
}

function openBookmark(node, useNewTab) {
  if (!node.url) {
    return;
  }

  if (useNewTab) {
    window.open(node.url, "_blank", "noopener,noreferrer");
    return;
  }

  window.location.assign(node.url);
}

function openFolderBookmarks(folder) {
  const bookmarks = folder.children.filter((child) => child.url);

  if (bookmarks.length === 0) {
    return;
  }

  bookmarks.forEach((bookmark) => {
    chrome.tabs.create({
      url: bookmark.url,
      active: false,
    });
  });
}

function handleKeydown(event) {
  const ignoredTags = ["INPUT", "TEXTAREA", "SELECT"];

  if (isModalOpen()) {
    return;
  }

  if (ignoredTags.includes(document.activeElement?.tagName)) {
    return;
  }

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveSelection(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      moveSelection(-1);
      break;
    case "ArrowRight":
      event.preventDefault();
      moveRight();
      break;
    case "ArrowLeft":
    case "Backspace":
      event.preventDefault();
      moveLeft();
      break;
    case "Enter":
      event.preventDefault();
      activateSelection(event.metaKey || event.ctrlKey);
      break;
    default:
      break;
  }
}

function moveSelection(direction) {
  const column = getColumnForParent(state.activeParentId || state.rootId);

  if (!column || column.items.length === 0) {
    return;
  }

  const currentId = getSelectedChildId(column.parentId);
  const currentIndex = column.items.findIndex((item) => item.id === currentId);
  const nextIndex = currentIndex === -1 ? (direction > 0 ? 0 : column.items.length - 1) : clamp(currentIndex + direction, 0, column.items.length - 1);
  const nextItem = column.items[nextIndex];

  if (!nextItem) {
    return;
  }

  if (isFolder(nextItem)) {
    const parentPath = getPathForParent(column.parentId);
    state.folderPath = [...parentPath, nextItem.id];
  } else {
    state.folderPath = getPathForParent(column.parentId);
  }

  state.selectedId = nextItem.id;
  render();
}

function moveRight() {
  const selectedNode = state.nodes.get(getSelectedChildId(state.activeParentId || state.rootId));

  if (!selectedNode) {
    return;
  }

  if (isFolder(selectedNode)) {
    state.folderPath = buildFolderPath(selectedNode.id);
    state.selectedId = selectedNode.id;
    state.activeParentId = selectedNode.id;

    const childColumn = getColumnForParent(selectedNode.id);
    const firstChild = childColumn?.items[0];

    if (firstChild) {
      state.selectedId = firstChild.id;
    }

    render();
    return;
  }

  openBookmark(selectedNode, false);
}

function moveLeft() {
  const currentParentId = state.activeParentId || state.rootId;

  if (currentParentId === state.rootId) {
    return;
  }

  const currentFolder = state.nodes.get(currentParentId);

  if (!currentFolder) {
    return;
  }

  const parentFolder = state.nodes.get(currentFolder.parentId);
  state.selectedId = currentFolder.id;
  state.folderPath = getPathForParent(parentFolder?.id || state.rootId);
  state.activeParentId = parentFolder?.id || state.rootId;
  render();
}

function activateSelection(useNewTab) {
  const activeColumn = getColumnForParent(state.activeParentId || state.rootId);
  const selectedNode = state.nodes.get(getSelectedChildId(activeColumn?.parentId));

  if (!selectedNode) {
    return;
  }

  if (isFolder(selectedNode)) {
    openFolder(selectedNode.id);
    return;
  }

  openBookmark(selectedNode, useNewTab);
}

function getColumnForParent(parentId) {
  return getVisibleColumns().find((column) => column.parentId === parentId);
}

function getSelectedChildId(parentId) {
  const selectedPathChild = state.folderPath.find((folderId) => {
    const node = state.nodes.get(folderId);
    return node?.parentId === parentId;
  });

  if (selectedPathChild) {
    return selectedPathChild;
  }

  const selectedNode = state.nodes.get(state.selectedId);

  if (selectedNode?.parentId === parentId) {
    return selectedNode.id;
  }

  return null;
}

function buildFolderPath(folderId) {
  const path = [];
  let currentId = folderId;

  while (currentId && currentId !== state.rootId) {
    const node = state.nodes.get(currentId);

    if (!node || !isFolder(node)) {
      break;
    }

    path.unshift(node.id);
    currentId = node.parentId;
  }

  return path;
}

function getPathForParent(parentId) {
  if (!parentId || parentId === state.rootId) {
    return [];
  }

  return buildFolderPath(parentId);
}

function alignPathToSelection() {
  const selectedNode = state.nodes.get(state.selectedId);

  if (!selectedNode) {
    state.folderPath = [];
    return;
  }

  if (isFolder(selectedNode)) {
    state.folderPath = buildFolderPath(selectedNode.id);
    return;
  }

  state.folderPath = buildFolderPath(selectedNode.parentId);
}

function buildTooltip(node) {
  if (!node.url) {
    return getNodeTitle(node);
  }

  return `${getNodeTitle(node)}\n${node.url}`;
}

function getNodeTitle(node) {
  if (node.title) {
    return node.title;
  }

  if (isFolder(node)) {
    return node.parentId === state.rootId ? "Untitled Folder" : "Untitled Folder";
  }

  return getBookmarkFallbackTitle(node.url);
}

function getBookmarkFallbackTitle(url) {
  if (!url) {
    return "Untitled Bookmark";
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = segments.at(-1);

    if (lastSegment) {
      return decodeURIComponent(lastSegment);
    }

    if (hostname) {
      return hostname;
    }
  } catch {
    return url.replace(/^https?:\/\//, "");
  }

  return url.replace(/^https?:\/\//, "");
}

function getFaviconUrl(url) {
  const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
  faviconUrl.searchParams.set("pageUrl", url);
  faviconUrl.searchParams.set("size", "32");
  return faviconUrl.toString();
}

function openContextMenu(nodeId, parentId, x, y) {
  const node = state.nodes.get(nodeId);

  if (!node) {
    return;
  }

  closeContextMenu();
  selectNode(nodeId, parentId);
  state.contextMenuNodeId = nodeId;

  const actions = [];

  if (!isFolder(node)) {
    actions.push({
      label: "Edit Bookmark...",
      onSelect: () => openEditor(nodeId, "edit-bookmark"),
    });
  }

  actions.push({
    label: "Rename",
    onSelect: () => openEditor(nodeId, "rename"),
  });

  actions.push({
    label: "Delete",
    onSelect: () => openDeleteDialog(nodeId),
  });

  const fragment = document.createDocumentFragment();

  for (const action of actions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "context-menu-item";
    item.role = "menuitem";
    item.textContent = action.label;
    item.addEventListener("click", () => {
      closeContextMenu();
      action.onSelect();
    });
    fragment.append(item);
  }

  elements.contextMenu.replaceChildren(fragment);
  elements.contextMenu.hidden = false;
  positionContextMenu(x, y);
}

function closeContextMenu() {
  state.contextMenuNodeId = null;
  elements.contextMenu.hidden = true;
  elements.contextMenu.replaceChildren();
}

function positionContextMenu(x, y) {
  const padding = 12;
  const rect = elements.contextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - padding;
  const maxTop = window.innerHeight - rect.height - padding;

  elements.contextMenu.style.left = `${Math.max(padding, Math.min(x, maxLeft))}px`;
  elements.contextMenu.style.top = `${Math.max(padding, Math.min(y, maxTop))}px`;
}

function openEditor(nodeId, mode) {
  const node = state.nodes.get(nodeId);

  if (!node) {
    return;
  }

  state.editorNodeId = nodeId;
  state.editorMode = mode;
  elements.editorError.hidden = true;
  elements.editorError.textContent = "";
  elements.editorName.value = node.title || "";
  elements.editorUrl.value = node.url || "";
  elements.editorUrlField.hidden = mode !== "edit-bookmark";
  elements.editorTitle.textContent = mode === "edit-bookmark" ? "Edit Bookmark" : isFolder(node) ? "Rename Folder" : "Rename Bookmark";
  elements.editorBackdrop.hidden = false;

  window.requestAnimationFrame(() => {
    elements.editorName.focus();
    elements.editorName.select();
  });
}

function closeEditor() {
  state.editorNodeId = null;
  state.editorMode = null;
  elements.editorBackdrop.hidden = true;
  elements.editorError.hidden = true;
  elements.editorError.textContent = "";
  focusActiveColumn();
}

function openDeleteDialog(nodeId) {
  const node = state.nodes.get(nodeId);

  if (!node) {
    return;
  }

  state.deleteNodeId = nodeId;
  elements.deleteTitle.textContent = isFolder(node) ? "Delete Folder" : "Delete Bookmark";
  elements.deleteMessage.textContent = isFolder(node)
    ? `Delete \"${getNodeTitle(node)}\" and everything inside it?`
    : `Delete \"${getNodeTitle(node)}\"?`;
  elements.deleteError.hidden = true;
  elements.deleteError.textContent = "";
  elements.deleteBackdrop.hidden = false;

  window.requestAnimationFrame(() => {
    elements.deleteConfirm.focus();
  });
}

function closeDeleteDialog() {
  state.deleteNodeId = null;
  elements.deleteBackdrop.hidden = true;
  elements.deleteError.hidden = true;
  elements.deleteError.textContent = "";
  focusActiveColumn();
}

async function handleEditorSubmit(event) {
  event.preventDefault();

  const node = state.nodes.get(state.editorNodeId);

  if (!node) {
    closeEditor();
    return;
  }

  const changes = {
    title: elements.editorName.value,
  };

  if (state.editorMode === "edit-bookmark") {
    const normalizedUrl = normalizeBookmarkUrl(elements.editorUrl.value);

    if (!normalizedUrl) {
      showEditorError("Enter a valid URL.");
      return;
    }

    changes.url = normalizedUrl;
  }

  try {
    await chrome.bookmarks.update(node.id, changes);
    closeEditor();
    await loadBookmarks();
  } catch (error) {
    showEditorError(error?.message || "Unable to save bookmark changes.");
  }
}

function showEditorError(message) {
  elements.editorError.hidden = false;
  elements.editorError.textContent = message;
}

async function handleDeleteConfirm() {
  const node = state.nodes.get(state.deleteNodeId);

  if (!node) {
    closeDeleteDialog();
    return;
  }

  elements.deleteError.hidden = true;
  elements.deleteError.textContent = "";
  elements.deleteConfirm.disabled = true;
  elements.deleteCancel.disabled = true;

  try {
    if (isFolder(node)) {
      await chrome.bookmarks.removeTree(node.id);
    } else {
      await chrome.bookmarks.remove(node.id);
    }

    closeDeleteDialog();
    await loadBookmarks();
  } catch (error) {
    elements.deleteError.hidden = false;
    elements.deleteError.textContent = error?.message || "Unable to delete bookmark.";
  } finally {
    elements.deleteConfirm.disabled = false;
    elements.deleteCancel.disabled = false;
  }
}

function handleEditorBackdropMouseDown(event) {
  if (event.target === elements.editorBackdrop) {
    closeEditor();
  }
}

function handleDeleteBackdropMouseDown(event) {
  if (event.target === elements.deleteBackdrop) {
    closeDeleteDialog();
  }
}

function handleDocumentMouseDown(event) {
  if (!elements.contextMenu.hidden && !elements.contextMenu.contains(event.target)) {
    closeContextMenu();
  }
}

function handleGlobalKeydown(event) {
  if (event.key !== "Escape") {
    return;
  }

  if (!elements.contextMenu.hidden) {
    closeContextMenu();
  }

  if (!elements.editorBackdrop.hidden) {
    event.preventDefault();
    closeEditor();
    return;
  }

  if (!elements.deleteBackdrop.hidden) {
    event.preventDefault();
    closeDeleteDialog();
  }
}

function isModalOpen() {
  return !elements.editorBackdrop.hidden || !elements.deleteBackdrop.hidden;
}

function selectNode(nodeId, parentId) {
  const node = state.nodes.get(nodeId);

  if (!node) {
    return;
  }

  state.activeParentId = parentId;
  state.selectedId = nodeId;
  state.folderPath = isFolder(node) ? buildFolderPath(nodeId) : getPathForParent(parentId);
  render();
}

function normalizeBookmarkUrl(value) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  try {
    return new URL(trimmedValue).toString();
  } catch {
    return null;
  }
}

function focusActiveColumn() {
  const activeColumn = elements.columns.querySelector(`.column-items[data-parent-id="${CSS.escape(state.activeParentId || state.rootId)}"]`);

  if (activeColumn && document.activeElement !== activeColumn) {
    activeColumn.focus({ preventScroll: true });
  }
}

function scrollSelectionIntoView() {
  const activeColumn = elements.columns.querySelector(`.column-items[data-parent-id="${CSS.escape(state.activeParentId || state.rootId)}"]`);
  const selectedRow = activeColumn?.querySelector(".row.selected");

  selectedRow?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function queueRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(loadBookmarks, 60);
}

function showError(error) {
  elements.columns.replaceChildren();
  const message = document.createElement("div");
  message.className = "empty-state";
  message.textContent = error?.message || "Chrome bookmark access failed.";
  elements.columns.append(message);
}

function isFolder(node) {
  return !node.url;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
