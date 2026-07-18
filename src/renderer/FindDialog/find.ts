// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
document.addEventListener('DOMContentLoaded', () => {
    const findInput = document.getElementById('find-input');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const closeBtn = document.getElementById('close-btn');
    const matchCounter = document.getElementById('match-counter');

    let currentMatchIndex = 0;
    let totalMatches = 0;
    let searchTimeout = null;

    findInput.focus();

    findInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.trim();
        
        if (searchTimeout) {
            clearTimeout(searchTimeout);
        }
        
        if (searchTerm) {
            searchTimeout = setTimeout(() => {
                window.findAPI.search(searchTerm);
            }, 300);
        } else {
            window.findAPI.clearSearch();
            updateMatchCounter(0, 0);
        }
    });

    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            
            if (searchTimeout) {
                clearTimeout(searchTimeout);
                searchTimeout = null;
            }
            
            const searchTerm = findInput.value.trim();
            if (searchTerm) {
                window.findAPI.search(searchTerm);
                
                setTimeout(() => {
                    if (e.shiftKey) {
                        findPrevious();
                    } else {
                        findNext();
                    }
                }, 50);
            }
        } else if (e.key === 'Escape') {
            closeDialog();
        }
    });

    prevBtn.addEventListener('click', findPrevious);
    nextBtn.addEventListener('click', findNext);
    closeBtn.addEventListener('click', closeDialog);

    function findNext() {
        const searchTerm = findInput.value.trim();
        if (searchTerm) {
            window.findAPI.findNext();
        }
    }

    function findPrevious() {
        const searchTerm = findInput.value.trim();
        if (searchTerm) {
            window.findAPI.findPrevious();
        }
    }

    function closeDialog() {
        if (searchTimeout) {
            clearTimeout(searchTimeout);
            searchTimeout = null;
        }
        window.findAPI.close();
    }

    function updateMatchCounter(current, total) {
        currentMatchIndex = current;
        totalMatches = total;
        
        if (total === 0) {
            matchCounter.textContent = 'No matches';
            prevBtn.disabled = true;
            nextBtn.disabled = true;
        } else {
            matchCounter.textContent = `${current} of ${total}`;
            prevBtn.disabled = false;
            nextBtn.disabled = false;
        }
    }

    if (window.findAPI) {
        window.findAPI.onMatchesUpdated((current, total) => {
            updateMatchCounter(current, total);
        });
    }
});
})();
