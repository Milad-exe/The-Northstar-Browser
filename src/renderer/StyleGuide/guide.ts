(() => {
    document.querySelectorAll('.theme-btn').forEach((btn: any) => {
        btn.addEventListener('click', () => {
            const t = btn.dataset.theme;
            if (t) document.documentElement.setAttribute('data-theme', t);
            else document.documentElement.removeAttribute('data-theme');
        });
    });
})();
