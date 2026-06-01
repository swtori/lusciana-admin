(() => {
    const AUTH_KEY = 'lusciana-auth-session';
    const ALLOWED_EXT = ['.schematic', '.litematic', '.bp', '.schem'];

    const API_BASE_URL = (() => {
        const override = new URLSearchParams(window.location.search).get('apiBase');
        if (override) {
            return override.replace(/\/$/, '');
        }
        if (window.location.protocol === 'file:') {
            return 'http://localhost:4000/api';
        }
        const segments = window.location.pathname.split('/').filter(Boolean);
        let appRootIndex = -1;
        for (let i = 0; i < segments.length; i++) {
            if (segments[i] === 'pages' || segments[i] === 'admin') {
                appRootIndex = i;
                break;
            }
        }
        if (appRootIndex > 0) {
            const prefix = '/' + segments.slice(0, appRootIndex).join('/');
            return `${window.location.origin}${prefix}/api`;
        }
        return `${window.location.origin}/api`;
    })();

    const backLink = document.getElementById('schematicsBackLink');
    if (backLink) {
        backLink.href = 'index.html';
    }

    let accessToken = null;
    let refreshToken = null;
    let currentUser = null;
    let selectedFile = null;
    let lastDiagnostics = null;

    const authPanel = document.getElementById('schematicsAuthPanel');
    const sessionPanel = document.getElementById('schematicsSessionPanel');
    const sessionLabel = document.getElementById('schematicsSessionLabel');
    const loginForm = document.getElementById('schematicsLoginForm');
    const dropzone = document.getElementById('schematicsDropzone');
    const fileInput = document.getElementById('schematicsFileInput');
    const selectedEl = document.getElementById('schematicsSelected');
    const uploadBtn = document.getElementById('schematicsUploadBtn');
    const clearBtn = document.getElementById('schematicsClearBtn');
    const statusEl = document.getElementById('schematicsStatus');
    const maxSizeHint = document.getElementById('schematicsMaxSizeHint');
    const historyPanel = document.getElementById('schematicsHistoryPanel');
    const historyList = document.getElementById('schematicsHistoryList');
    const ROLE_ORDER = ['guest', 'builder', 'manager', 'admin', 'superadmin'];

    function roleAtLeast(minimumRole) {
        const role = currentUser?.role || 'guest';
        return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimumRole);
    }

    function formatLogDate(value) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('fr-FR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function formatLogBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n} o`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
        return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
    }

    function renderHistory(items) {
        if (!historyList) return;
        if (!Array.isArray(items) || items.length === 0) {
            historyList.innerHTML = '<p class="schematics-history-empty">Aucun envoi enregistré.</p>';
            return;
        }

        historyList.innerHTML = items.map((item) => {
            const failed = item.status === 'failed';
            const label = failed
                ? (item.originalFilename || item.filename || 'Fichier inconnu')
                : (item.filename || item.originalFilename || 'Fichier');
            const who = item.userName || item.userEmail || item.userId || '?';
            const meta = failed
                ? `Échec · ${item.errorMessage || 'Erreur'}`
                : `${formatLogBytes(item.sizeBytes)} · ${item.path || ''}`;

            return `<div class="schematics-history-item${failed ? ' is-failed' : ''}">
                <strong>${failed ? '✗' : '✓'} ${label}</strong>
                <div class="schematics-history-meta">${formatLogDate(item.uploadedAt)} · ${who} (${item.userRole || '?'}) · ${meta}</div>
            </div>`;
        }).join('');
    }

    async function loadHistory() {
        if (!accessToken || !roleAtLeast('manager')) {
            historyPanel?.classList.add('hidden');
            return;
        }

        try {
            const limit = roleAtLeast('admin') ? 500 : 200;
            const response = await fetch(`${API_BASE_URL}/schematics/logs?limit=${limit}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            const raw = await response.text();
            const payload = parseResponseBody(response, raw);
            if (!response.ok) {
                historyPanel?.classList.add('hidden');
                return;
            }
            historyPanel?.classList.remove('hidden');
            renderHistory(payload.items || []);
        } catch {
            historyPanel?.classList.add('hidden');
        }
    }

    const debugPanel = document.getElementById('schematicsDebugPanel');
    const debugOutput = document.getElementById('schematicsDebugOutput');
    const apiUrlEl = document.getElementById('schematicsApiUrl');

    if (apiUrlEl) {
        apiUrlEl.textContent = API_BASE_URL;
    }

    function showStatus(message, type) {
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.className = `schematics-status is-visible ${type || 'info'}`;
    }

    function hideStatus() {
        if (!statusEl) return;
        statusEl.className = 'schematics-status';
        statusEl.textContent = '';
    }

    function setBusy(busy) {
        if (dropzone) dropzone.classList.toggle('is-busy', busy);
        if (uploadBtn) uploadBtn.disabled = busy || !accessToken || !selectedFile;
        if (clearBtn) clearBtn.disabled = busy;
    }

    function formatDiagnostics(diag) {
        if (!diag || typeof diag !== 'object') {
            return 'Diagnostic indisponible (backend pas à jour ? Déploie la dernière version PHP.)';
        }

        const lines = [
            `Chemin configuré : ${diag.uploadDir ?? '?'}`,
            `Existe : ${diag.uploadDirExists ? 'oui' : 'NON'}`,
            `Inscriptible : ${diag.uploadDirWritable ? 'oui' : 'NON'}`,
            `Chemin résolu (realpath) : ${diag.realpath ?? '(introuvable)'}`,
            `Utilisateur PHP : ${diag.phpUser ?? '?'}`,
            `Machine : ${diag.hostname ?? '?'}`,
            `Limites PHP : upload_max_filesize=${diag.uploadMaxFilesize ?? '?'}, post_max_size=${diag.postMaxSize ?? '?'}`,
            `Fichiers dans le dossier : ${diag.fileCount ?? 0}`,
        ];

        if (Array.isArray(diag.recentFiles) && diag.recentFiles.length > 0) {
            lines.push(`Exemples : ${diag.recentFiles.join(', ')}`);
        }

        if (diag.uploadDirExists && !diag.uploadDirWritable) {
            lines.push('');
            lines.push('→ PHP ne peut pas écrire ici. Vérifie chown/chmod ou l’utilisateur du processus web.');
        }

        if (diag.realpath && diag.uploadDir && diag.realpath !== diag.uploadDir.replace(/\/$/, '')) {
            lines.push('');
            lines.push('→ Le chemin résolu diffère du chemin configuré (symlink ou conteneur Docker ?).');
        }

        return lines.join('\n');
    }

    function renderDiagnostics(diag) {
        lastDiagnostics = diag || null;
        if (!debugPanel || !debugOutput) return;
        debugPanel.classList.remove('hidden');
        debugOutput.textContent = formatDiagnostics(diag);
    }

    function restoreSession() {
        try {
            const raw = sessionStorage.getItem(AUTH_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (!data?.accessToken || !data?.refreshToken || !data?.user) return false;
            accessToken = data.accessToken;
            refreshToken = data.refreshToken;
            currentUser = data.user;
            return true;
        } catch {
            return false;
        }
    }

    function persistSession() {
        if (!accessToken || !refreshToken || !currentUser) return;
        sessionStorage.setItem(AUTH_KEY, JSON.stringify({
            accessToken,
            refreshToken,
            user: currentUser
        }));
    }

    function clearSession() {
        accessToken = null;
        refreshToken = null;
        currentUser = null;
        sessionStorage.removeItem(AUTH_KEY);
        debugPanel?.classList.add('hidden');
        historyPanel?.classList.add('hidden');
    }

    function updateAuthUI() {
        const loggedIn = Boolean(accessToken && currentUser);
        authPanel?.classList.toggle('hidden', loggedIn);
        sessionPanel?.classList.toggle('hidden', !loggedIn);
        if (loggedIn && sessionLabel) {
            sessionLabel.textContent = `${currentUser.name || currentUser.email} (${currentUser.role})`;
        }
        if (uploadBtn) uploadBtn.disabled = !loggedIn || !selectedFile;
    }

    function isAllowedFile(file) {
        if (!file) return false;
        const name = file.name.toLowerCase();
        return ALLOWED_EXT.some((ext) => name.endsWith(ext));
    }

    function setSelectedFile(file) {
        selectedFile = isAllowedFile(file) ? file : null;
        if (selectedEl) {
            selectedEl.textContent = selectedFile
                ? `Fichier sélectionné : ${selectedFile.name} (${formatBytes(selectedFile.size)})`
                : '';
            selectedEl.style.display = selectedFile ? 'block' : 'none';
        }
        if (uploadBtn) uploadBtn.disabled = !accessToken || !selectedFile;
        hideStatus();
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} o`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
    }

    function parseResponseBody(response, rawText) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            try {
                return JSON.parse(rawText);
            } catch {
                return { message: rawText.slice(0, 300) || `Erreur ${response.status}` };
            }
        }
        return { message: rawText.slice(0, 300) || `Erreur ${response.status} (réponse non JSON)` };
    }

    function formatApiError(response, payload) {
        let message = payload?.message || `Erreur HTTP ${response.status}`;

        if (response.status === 404) {
            message += '\n\n→ Route API introuvable. Le backend sur le VPS est peut‑être pas à jour (fichiers PHP non déployés).';
        }
        if (response.status === 403) {
            message += '\n\n→ Compte guest ou rôle insuffisant. Il faut au minimum builder.';
        }
        if (response.status === 413 || /trop volumineux/i.test(message)) {
            message += '\n\n→ Augmente upload_max_filesize et post_max_size dans la config PHP du serveur.';
        }
        if (/non inscriptible|inaccessible/i.test(message)) {
            message += '\n\n→ Ouvre « Diagnostic serveur » ci‑dessous pour voir le chemin et l’utilisateur PHP.';
        }

        return message;
    }

    async function refreshSession() {
        const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        });
        const raw = await response.text();
        const payload = parseResponseBody(response, raw);
        if (!response.ok) {
            throw new Error(payload.message || 'Session expirée');
        }
        accessToken = payload.accessToken;
        refreshToken = payload.refreshToken;
        currentUser = payload.user;
        persistSession();
    }

    async function apiUpload(retryOnAuthFailure) {
        if (!selectedFile) {
            throw new Error('Aucun fichier sélectionné');
        }

        const formData = new FormData();
        formData.append('file', selectedFile);

        const headers = {};
        if (accessToken) {
            headers.Authorization = `Bearer ${accessToken}`;
        }

        let response;
        try {
            response = await fetch(`${API_BASE_URL}/schematics/upload`, {
                method: 'POST',
                headers,
                body: formData
            });
        } catch (error) {
            throw new Error(
                `Réseau inaccessible vers ${API_BASE_URL}/schematics/upload\n\n`
                + (error?.message || 'Failed to fetch')
                + '\n\n→ Vérifie que l’API répond (onglet Réseau F12).'
            );
        }

        const raw = await response.text();
        const payload = parseResponseBody(response, raw);
        console.log('[schematics] upload', response.status, payload);

        if (response.status === 401 && retryOnAuthFailure && refreshToken) {
            await refreshSession();
            return apiUpload(false);
        }

        if (!response.ok) {
            const err = new Error(formatApiError(response, payload));
            err.payload = payload;
            throw err;
        }

        if (payload.diagnostics) {
            renderDiagnostics(payload.diagnostics);
        }

        return payload;
    }

    async function loadInfo() {
        if (!accessToken) return;

        try {
            const response = await fetch(`${API_BASE_URL}/schematics/info`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            const raw = await response.text();
            const payload = parseResponseBody(response, raw);
            console.log('[schematics] info', response.status, payload);

            if (!response.ok) {
                if (response.status === 404) {
                    renderDiagnostics(null);
                    showStatus(
                        'API schematics absente (404). Déploie le backend PHP mis à jour sur le VPS.',
                        'error'
                    );
                }
                return;
            }

            if (payload.maxMb && maxSizeHint) {
                maxSizeHint.textContent = `Taille max : ${payload.maxMb} Mo · Formats : ${(payload.allowedExtensions || ALLOWED_EXT).join(', ')}`;
            }

            if (payload.diagnostics) {
                renderDiagnostics(payload.diagnostics);
            }
            await loadHistory();
        } catch (error) {
            console.warn('[schematics] info failed', error);
            showStatus(`Impossible de joindre l’API : ${API_BASE_URL}`, 'error');
        }
    }

    loginForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const email = document.getElementById('schematicsLoginEmail')?.value?.trim();
        const password = document.getElementById('schematicsLoginPassword')?.value || '';
        if (!email || !password) return;

        setBusy(true);
        hideStatus();
        try {
            const response = await fetch(`${API_BASE_URL}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const raw = await response.text();
            const payload = parseResponseBody(response, raw);
            if (!response.ok) {
                throw new Error(payload.message || 'Connexion impossible');
            }
            accessToken = payload.accessToken;
            refreshToken = payload.refreshToken;
            currentUser = payload.user;
            persistSession();
            updateAuthUI();
            await loadInfo();
            await loadHistory();
            showStatus('Connecté. Lance un diagnostic puis envoie un fichier.', 'success');
        } catch (error) {
            showStatus(error.message || 'Connexion impossible', 'error');
        } finally {
            setBusy(false);
        }
    });

    document.getElementById('schematicsLogoutBtn')?.addEventListener('click', () => {
        clearSession();
        setSelectedFile(null);
        if (fileInput) fileInput.value = '';
        updateAuthUI();
        hideStatus();
    });

    dropzone?.addEventListener('click', () => fileInput?.click());

    dropzone?.addEventListener('dragover', (event) => {
        event.preventDefault();
        dropzone.classList.add('is-dragover');
    });

    dropzone?.addEventListener('dragleave', () => {
        dropzone.classList.remove('is-dragover');
    });

    dropzone?.addEventListener('drop', (event) => {
        event.preventDefault();
        dropzone.classList.remove('is-dragover');
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        if (!isAllowedFile(file)) {
            showStatus('Format non accepté. Utilisez .schematic, .litematic, .bp ou .schem uniquement.', 'error');
            return;
        }
        setSelectedFile(file);
    });

    fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (!file) {
            setSelectedFile(null);
            return;
        }
        if (!isAllowedFile(file)) {
            fileInput.value = '';
            showStatus('Format non accepté. Utilisez .schematic, .litematic, .bp ou .schem uniquement.', 'error');
            return;
        }
        setSelectedFile(file);
    });

    clearBtn?.addEventListener('click', () => {
        if (fileInput) fileInput.value = '';
        setSelectedFile(null);
    });

    uploadBtn?.addEventListener('click', async () => {
        if (!accessToken) {
            showStatus('Connectez-vous pour envoyer un fichier.', 'error');
            return;
        }
        if (!selectedFile) {
            showStatus('Sélectionnez un fichier, puis cliquez « Envoyer sur le serveur ».', 'error');
            return;
        }

        setBusy(true);
        hideStatus();
        try {
            const payload = await apiUpload(true);
            const item = payload?.item || {};
            const filename = item.filename || selectedFile.name;
            const path = item.path ? `\nChemin serveur : ${item.path}` : '';
            showStatus(`✅ ${filename} enregistré.${path}`, 'success');
            if (payload.diagnostics) {
                renderDiagnostics(payload.diagnostics);
            }
            if (fileInput) fileInput.value = '';
            setSelectedFile(null);
            await loadHistory();
        } catch (error) {
            if (error.payload?.diagnostics) {
                renderDiagnostics(error.payload.diagnostics);
            } else if (lastDiagnostics) {
                renderDiagnostics(lastDiagnostics);
            }
            showStatus(error.message || 'Envoi impossible', 'error');
        } finally {
            setBusy(false);
        }
    });

    if (restoreSession()) {
        updateAuthUI();
        void loadInfo();
        void loadHistory();
    } else {
        updateAuthUI();
    }
})();
