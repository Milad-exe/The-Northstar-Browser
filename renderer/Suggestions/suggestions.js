(function(){
  const listEl = document.getElementById('list');
  let current = { items: [], activeIndex: -1 };

  function render(payload) {
    const { items = [], activeIndex = -1 } = payload || {};
    current.items = items;
    current.activeIndex = activeIndex;
    listEl.innerHTML = '';

    items.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'item' + (idx === activeIndex ? ' active' : '');

      const isSearch = item.type === 'action' || item.type === 'google' || item.type === 'duckduckgo' || item.type === 'bing';

      const SVG_SEARCH = 'data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" stroke="%23999" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
      const SVG_GLOBE  = 'data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" stroke="%23999" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>';
      const SVG_BKMK   = 'data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" stroke="%23999" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>';
      const SVG_HIST   = 'data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" stroke="%23999" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';

      let defaultIcon = SVG_GLOBE;
      if (isSearch) defaultIcon = SVG_SEARCH;
      else if (item.type === 'bookmark') defaultIcon = SVG_BKMK;
      else if (item.type === 'history') defaultIcon = SVG_HIST;

      // Favicon
      const icon = document.createElement('img');
      icon.className = 'fav';
      icon.width = 14; icon.height = 14;
      icon.alt = '';
      icon.onerror = () => { icon.src = defaultIcon; };

      try {
        if (item.favicon) {
          icon.src = item.favicon;
        } else if (isSearch) {
          icon.src = SVG_SEARCH;
        } else if (item.url) {
          const urlObj = new URL(item.url);
          if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
             icon.src = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
          } else {
             icon.src = defaultIcon;
          }
        } else {
          icon.src = defaultIcon;
        }
      } catch {
        icon.src = defaultIcon;
      }
      el.appendChild(icon);

      // Main label — "Title — url" for navigable items, just query for search items
      const main = document.createElement('span');
      main.className = 'main-label';

      if (!isSearch && item.url) {
        const title = item.title && item.title !== item.url ? item.title : null;
        if (title) {
          // "Page Title" in normal weight, "— url" dimmed
          const titleSpan = document.createElement('span');
          titleSpan.className = 'label-title';
          titleSpan.textContent = title;
          const sepSpan = document.createElement('span');
          sepSpan.className = 'label-sep';
          sepSpan.textContent = ' — ';
          const urlSpan = document.createElement('span');
          urlSpan.className = 'label-url';
          urlSpan.textContent = item.url;
          main.appendChild(titleSpan);
          main.appendChild(sepSpan);
          main.appendChild(urlSpan);
        } else {
          main.textContent = item.url;
        }
        // Full URL in tooltip on the whole row
        el.title = item.url;
      } else {
        main.textContent = item.query || item.title || item.url || '';
      }

      el.appendChild(main);

      // Right-side pill/badge
      const secondary = document.createElement('span');
      secondary.className = 'secondary';
      if (item.type === 'switch-tab')  secondary.textContent = 'Switch';
      else if (item.type === 'navigate') secondary.textContent = 'Visit';
      else if (item.type === 'action') secondary.textContent = 'Search';
      else if (item.type === 'google') secondary.textContent = 'Google';
      else if (item.type === 'duckduckgo') secondary.textContent = 'DDG';
      else if (item.type === 'bing')   secondary.textContent = 'Bing';
      else if (item.type === 'history') secondary.textContent = 'History';
      else if (item.type === 'bookmark') secondary.textContent = 'Bookmark';

      if (secondary.textContent) el.appendChild(secondary);

      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        try {
          if (window.overlaySuggestions && window.overlaySuggestions.pointerDown) {
            window.overlaySuggestions.pointerDown();
          }
        } catch {}
        window.overlaySuggestions.select(item);
      });

      listEl.appendChild(el);
    });
  }

  window.overlaySuggestions.onData((payload) => {
    render(payload);
  });
})();
