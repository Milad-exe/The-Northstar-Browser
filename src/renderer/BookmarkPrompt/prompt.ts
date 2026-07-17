// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
window.electronAPI.onInitPrompt((event, { url, title, hasObj, id, mode }) => {
  const heading    = document.getElementById('prompt-heading');
  const titleInput = document.getElementById('bookmark-title');
  const actions    = document.getElementById('prompt-actions');
  const fieldLabel = document.querySelector('.field label');

  // ── New folder mode ──────────────────────────────────────────────────────
  if (mode === 'new-folder') {
    heading.textContent = 'New Folder';
    if (fieldLabel) fieldLabel.textContent = 'Name';
    titleInput.value       = '';
    titleInput.placeholder = 'Folder name';
    actions.innerHTML = `
      <button id="btn-cancel">Cancel</button>
      <button class="primary" id="btn-create">Create</button>
    `;
    document.getElementById('btn-cancel').addEventListener('click', () => window.electronAPI.closePrompt());
    document.getElementById('btn-create').addEventListener('click', () => {
      const name = titleInput.value.trim();
      if (name) window.electronAPI.addFolder(name);
      window.electronAPI.closePrompt();
    });
    titleInput.focus();
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-create')?.click();
      if (e.key === 'Escape') window.electronAPI.closePrompt();
    });
    return;
  }

  // ── Folder rename mode ───────────────────────────────────────────────────
  if (mode === 'folder-rename') {
    heading.textContent    = 'Rename Folder';
    if (fieldLabel) fieldLabel.textContent = 'Name';
    titleInput.value       = title || '';
    actions.innerHTML = `
      <button id="btn-cancel">Cancel</button>
      <button class="primary" id="btn-save">Save</button>
    `;
    document.getElementById('btn-cancel').addEventListener('click', () => window.electronAPI.closePrompt());
    document.getElementById('btn-save').addEventListener('click', () => {
      const newTitle = titleInput.value.trim() || title;
      if (newTitle !== title) window.electronAPI.updateById(id, { title: newTitle });
      window.electronAPI.closePrompt();
    });
    titleInput.focus();
    titleInput.select();
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-save')?.click();
      if (e.key === 'Escape') window.electronAPI.closePrompt();
    });
    return;
  }

  // ── Bookmark add / edit mode ─────────────────────────────────────────────
  titleInput.value       = title || '';
  heading.textContent    = hasObj ? 'Edit Bookmark' : 'Add Bookmark';
  if (fieldLabel) fieldLabel.textContent = 'Title';

  if (hasObj) {
    actions.innerHTML = `
      <button class="remove" id="btn-remove">Remove</button>
      <button class="primary" id="btn-done">Done</button>
    `;
    document.getElementById('btn-remove').addEventListener('click', () => {
      if (id) window.electronAPI.removeById(id);
      else    window.electronAPI.removeBookmark(url);
      window.electronAPI.closePrompt();
    });
    document.getElementById('btn-done').addEventListener('click', () => {
      const newTitle = titleInput.value.trim() || title;
      if (newTitle !== title) {
        if (id) window.electronAPI.updateById(id, { title: newTitle });
        else    window.electronAPI.updateTitle(url, newTitle);
      }
      window.electronAPI.closePrompt();
    });
  } else {
    actions.innerHTML = `
      <button id="btn-cancel">Cancel</button>
      <button class="primary" id="btn-save">Save</button>
    `;
    document.getElementById('btn-cancel').addEventListener('click', () => window.electronAPI.closePrompt());
    document.getElementById('btn-save').addEventListener('click', () => {
      window.electronAPI.addBookmark(url, titleInput.value.trim() || title);
      window.electronAPI.closePrompt();
    });
  }

  titleInput.focus();
  titleInput.select();

  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      (document.getElementById('btn-save') || document.getElementById('btn-done'))?.click();
    }
    if (e.key === 'Escape') window.electronAPI.closePrompt();
  });
});
})();
