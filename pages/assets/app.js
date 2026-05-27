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

        let agentsCache = [];
        let commissionsCache = [];
        let expensesCache = [];
        let usersCache = [];
        let todosCache = [];
        let accountProfile = null;
        let accessToken = null;
        let refreshToken = null;
        let currentUser = null;

        const LUSCIANA_AUTH_STORAGE_KEY = 'lusciana-auth-session';
        const LUSCIANA_SESSION_STARTED_KEY = 'lusciana-session-started';
        const LUSCIANA_SESSION_ACTIVITY_KEY = 'lusciana-session-activity';
        /** Inactivité max avant déconnexion automatique (30 min). */
        const SESSION_IDLE_MS = 30 * 60 * 1000;
        /** Durée max d'une session depuis la connexion (8 h, alignée sur le refresh token). */
        const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
        /** Cache navigateur (sessionStorage) pour atténuer le coût d’un rechargement complet à chaque page HTML. */
        const REMOTE_DATA_CACHE_KEY = 'lusciana-remote-data-v1';
        let sessionIdleTimer = null;
        let sessionActivityPersistAt = 0;

        function remoteDataCacheUserKey() {
            if (!currentUser) {
                return null;
            }
            const id = currentUser.id ?? currentUser._id;
            if (id !== undefined && id !== null && String(id) !== '') {
                return 'id:' + String(id);
            }
            const email = currentUser.email;
            if (email && String(email).trim() !== '') {
                return 'em:' + String(email).trim().toLowerCase();
            }
            return null;
        }

        function clearSessionRemoteDataCache() {
            try {
                sessionStorage.removeItem(REMOTE_DATA_CACHE_KEY);
            } catch (e) {
                /* ignore */
            }
        }

        function readSessionRemoteDataCache(expectedKey) {
            if (!expectedKey) {
                return null;
            }
            try {
                const raw = sessionStorage.getItem(REMOTE_DATA_CACHE_KEY);
                if (!raw) {
                    return null;
                }
                const parsed = JSON.parse(raw);
                if (!parsed || parsed.userKey !== expectedKey || typeof parsed.payload !== 'object' || parsed.payload === null) {
                    return null;
                }
                return parsed.payload;
            } catch {
                return null;
            }
        }

        function writeSessionRemoteDataCache(userKey, payload) {
            if (!userKey) {
                return;
            }
            try {
                sessionStorage.setItem(REMOTE_DATA_CACHE_KEY, JSON.stringify({
                    userKey,
                    payload
                }));
            } catch (e) {
                /* quota, mode privé */
            }
        }

        function applyRemotePayload(payload) {
            const p = payload || {};
            agentsCache = Array.isArray(p.agents) ? p.agents : [];
            commissionsCache = Array.isArray(p.commissions) ? p.commissions : [];
            expensesCache = Array.isArray(p.expenses) ? p.expenses : [];
            usersCache = Array.isArray(p.users) ? p.users : [];
            todosCache = Array.isArray(p.todos) ? p.todos : [];
            accountProfile = p.accountProfile !== undefined ? p.accountProfile : null;
        }

        function decodeJwtPayload(token) {
            if (!token || typeof token !== 'string') {
                return null;
            }
            try {
                const segment = token.split('.')[1];
                if (!segment) {
                    return null;
                }
                const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
                const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
                return JSON.parse(atob(padded));
            } catch {
                return null;
            }
        }

        function isJwtExpired(token) {
            const payload = decodeJwtPayload(token);
            if (!payload || typeof payload.exp !== 'number') {
                return true;
            }
            return Date.now() >= payload.exp * 1000;
        }

        function isSessionExpiredByPolicy() {
            if (!accessToken) {
                return false;
            }
            const now = Date.now();
            const started = Number(sessionStorage.getItem(LUSCIANA_SESSION_STARTED_KEY));
            const lastActivity = Number(sessionStorage.getItem(LUSCIANA_SESSION_ACTIVITY_KEY));
            if (Number.isFinite(started) && now - started > SESSION_MAX_MS) {
                return true;
            }
            if (Number.isFinite(lastActivity) && now - lastActivity > SESSION_IDLE_MS) {
                return true;
            }
            return isJwtExpired(refreshToken);
        }

        function markSessionStarted() {
            const now = Date.now();
            try {
                sessionStorage.setItem(LUSCIANA_SESSION_STARTED_KEY, String(now));
                sessionStorage.setItem(LUSCIANA_SESSION_ACTIVITY_KEY, String(now));
            } catch (e) {
                /* ignore */
            }
            sessionActivityPersistAt = now;
            resetSessionIdleTimer();
        }

        function touchSessionActivity() {
            if (!accessToken) {
                return;
            }
            const now = Date.now();
            resetSessionIdleTimer();
            if (now - sessionActivityPersistAt < 60000) {
                return;
            }
            sessionActivityPersistAt = now;
            try {
                sessionStorage.setItem(LUSCIANA_SESSION_ACTIVITY_KEY, String(now));
            } catch (e) {
                /* ignore */
            }
        }

        function resetSessionIdleTimer() {
            if (sessionIdleTimer) {
                clearTimeout(sessionIdleTimer);
                sessionIdleTimer = null;
            }
            if (!accessToken) {
                return;
            }
            sessionIdleTimer = setTimeout(() => {
                void expireSession('idle');
            }, SESSION_IDLE_MS);
        }

        function clearSessionIdleTimer() {
            if (sessionIdleTimer) {
                clearTimeout(sessionIdleTimer);
                sessionIdleTimer = null;
            }
        }

        function bindSessionActivityListeners() {
            const events = ['click', 'keydown', 'mousemove', 'scroll', 'touchstart'];
            events.forEach(eventName => {
                document.addEventListener(eventName, touchSessionActivity, { passive: true });
            });
        }

        function migrateLegacyAuthStorage() {
            try {
                window.localStorage.removeItem(LUSCIANA_AUTH_STORAGE_KEY);
            } catch (e) {
                /* ignore */
            }
        }

        function persistAuthSession() {
            if (accessToken && refreshToken && currentUser) {
                try {
                    sessionStorage.setItem(LUSCIANA_AUTH_STORAGE_KEY, JSON.stringify({
                        accessToken,
                        refreshToken,
                        user: currentUser
                    }));
                } catch (e) {
                    console.warn('Impossible de sauver la session localement.', e);
                }
            }
        }

        function clearAuthSessionStorage() {
            try {
                sessionStorage.removeItem(LUSCIANA_AUTH_STORAGE_KEY);
                sessionStorage.removeItem(LUSCIANA_SESSION_STARTED_KEY);
                sessionStorage.removeItem(LUSCIANA_SESSION_ACTIVITY_KEY);
            } catch (e) {
                /* ignore */
            }
        }

        function resetDataCaches() {
            agentsCache = [];
            commissionsCache = [];
            expensesCache = [];
            usersCache = [];
            todosCache = [];
            accountProfile = null;
        }

        /**
         * Lit sessionStorage et remplit accessToken / refreshToken / currentUser.
         * Ne touche pas au rechargement API (fait par tryRestoreAuthSession).
         */
        function hydrateAuthFromSessionStorage() {
            accessToken = null;
            refreshToken = null;
            currentUser = null;
            let raw = null;
            try {
                raw = sessionStorage.getItem(LUSCIANA_AUTH_STORAGE_KEY);
            } catch (e) {
                return false;
            }
            if (!raw) {
                return false;
            }
            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                clearAuthSessionStorage();
                return false;
            }
            if (!data || !data.accessToken || !data.refreshToken || !data.user) {
                clearAuthSessionStorage();
                return false;
            }
            accessToken = data.accessToken;
            refreshToken = data.refreshToken;
            currentUser = data.user;
            if (isSessionExpiredByPolicy()) {
                clearAuthSessionStorage();
                accessToken = null;
                refreshToken = null;
                currentUser = null;
                return false;
            }
            resetSessionIdleTimer();
            return true;
        }

        async function expireSession(reason) {
            if (!accessToken && !refreshToken) {
                return;
            }
            console.info('[Lusciana] Session terminée (' + reason + ').');
            await logout();
        }

        async function tryRestoreAuthSession() {
            if (!accessToken || isSessionExpiredByPolicy()) {
                if (accessToken || refreshToken) {
                    clearSessionData();
                    setAuthenticatedState(false);
                    refreshUIAfterLoad();
                }
                return;
            }
            try {
                await loadRemoteData();
                persistAuthSession();
                resetSessionIdleTimer();
            } catch (error) {
                console.warn('Restauration de session impossible.', error);
                clearSessionData();
                setAuthenticatedState(false);
                refreshUIAfterLoad();
            }
        }

        const ROLE_ORDER = ['guest', 'builder', 'manager', 'admin', 'superadmin'];
        const TODO_STATUS_LABELS = {
            todo: 'À faire',
            in_progress: 'En cours',
            done: 'Terminé'
        };
        const SUPPORTED_LANGUAGES = ['fr', 'en', 'de'];
        let currentLanguage = 'fr';
        const I18N = {
            fr: {
                header: {
                    title: '🏗️ Commission Manager',
                    subtitleLoggedOut: 'Connectez-vous pour charger les données depuis l\'API MongoDB.',
                    subtitleLoggedIn: 'Données chargées depuis MongoDB via l’API serveur.',
                    language: 'Langue',
                    emailPlaceholder: 'Email',
                    passwordPlaceholder: 'Mot de passe',
                    login: 'Connexion',
                    logout: 'Déconnexion',
                    noSession: 'Aucune session active.',
                    connectedTo: 'Connecté à {api}'
                },
                roles: {
                    guest: 'Guest',
                    builder: 'Builder',
                    manager: 'Manager',
                    admin: 'Admin',
                    superadmin: 'Superadmin'
                },
                tabs: {
                    list: 'Liste des Commissions',
                    agentsManage: 'Gérer les Agents',
                    agentsList: 'Liste des Agents',
                    users: 'Utilisateurs',
                    todos: 'Todo List',
                    account: 'Mon compte',
                    analyst: 'Data Analyst',
                    data: 'Gestion des Données'
                },
                common: {
                    yes: 'Oui',
                    no: 'Non',
                    cancel: 'Annuler',
                    add: 'Ajouter',
                    edit: 'Modifier',
                    delete: 'Supprimer',
                    reset: 'Réinitialiser',
                    save: 'Enregistrer',
                    select: 'Sélectionner',
                    none: 'Aucun',
                    statusActive: 'Actif',
                    statusInactive: 'Désactivé',
                    never: 'Jamais',
                    deletedSuccess: 'Suppression effectuée avec succès.'
                },
                commissions: {
                    listTitle: 'Liste des Commissions',
                    new: '➕ Nouvelle commission',
                    back: '← Retour à la liste',
                    buildInfo: 'Informations du Build',
                    buildSize: 'La taille du build :',
                    buildName: 'Nom du build :',
                    worldName: 'Nom du monde :',
                    worldNameHint: 'Obligatoire, doit commencer par « c- ».',
                    description: 'Description de la demande :',
                    descriptionPlaceholder: 'Décrire la demande',
                    version: 'Version :',
                    selectVersion: 'Sélectionner une version',
                    priceDistribution: 'Répartition du Prix',
                    priceDistributionHint: 'Répartition (€) = part totale. % = taxe que l\'agent paie. Prix total = somme des répartitions. La taxe pré-remplit avec le taux de l\'agent.',
                    selectAgents: 'Sélectionner les agents :',
                    whoTookWhat: 'Qui a pris combien ?',
                    dates: 'Dates',
                    buildStart: 'Début build :',
                    buildEnd: 'On a fini le build :',
                    payment: 'Paiement',
                    depositPaid: 'Est-ce que l\'acompte est versé ?',
                    depositAmount: 'Acompte perçu (€)',
                    depositPlaceholder: 'Prix total / 2',
                    depositHint: 'Par défaut : prix total / 2. Pour les commissions en cours, seul l\'acompte est compté dans le Data Analyst.',
                    buildTypeTitle: 'Type de Build',
                    buildTypeQuestion: 'Modification/build de base ?',
                    baseBuild: 'Build de base',
                    modification: 'Modification',
                    organics: 'Organiques ?',
                    client: 'Client',
                    clientName: 'Nom du client :',
                    selectClient: 'Sélectionner un client',
                    createClient: '➕ Créer un client',
                    newClient: 'Nouveau client',
                    clientPseudo: 'Pseudo (IGN) :',
                    clientPseudoPlaceholder: 'Pseudo du client',
                    clientDiscord: 'Discord :',
                    clientDiscordPlaceholder: 'Discord du client',
                    addClient: 'Ajouter le client',
                    feedbackQuestion: 'Clients ont-ils donné un avis ?',
                    feedbackLabel: 'Avis du client :',
                    feedbackPlaceholder: 'Avis du client',
                    renderSection: 'Render',
                    renderLabel: 'Render :',
                    renderPlaceholder: 'URL ou chemin du render',
                    saveNew: '💾 Enregistrer la Commission',
                    saveEdit: '💾 Modifier la Commission',
                    reset: '🔄 Réinitialiser',
                    empty: 'Aucune commission enregistrée.',
                    finished: '✓ Terminée',
                    inProgress: 'En cours',
                    copyShowcase: '📋 Copier showcase',
                    edit: '✏️ Modifier',
                    delete: '🗑️ Supprimer',
                    infoSize: 'Taille',
                    infoWorld: 'Monde',
                    infoClient: 'Client',
                    infoRealizedBy: 'Réalisé par',
                    infoVersion: 'Version',
                    infoStart: 'Début',
                    infoEnd: 'Fin',
                    generatedPrice: 'Prix total (calculé) : {price} €',
                    showcaseCopied: 'Le texte showcase a été copié dans le presse-papiers.',
                    showcaseNotCopied: 'Le texte showcase n\'a pas pu être copié automatiquement.'
                },
                agents: {
                    addTitle: 'Ajouter un Agent',
                    listTitle: 'Liste des Agents',
                    pseudo: 'Pseudo (IGN) :',
                    discord: 'Discord :',
                    paymentMethods: 'Moyens de paiement :',
                    addPaymentMethod: '➕ Ajouter un moyen de paiement',
                    pf: 'PF (si dispo) :',
                    pfPlaceholder: 'Portfolio',
                    category: 'Catégorie :',
                    selectCategory: 'Sélectionner',
                    manager: 'Manager',
                    apprentice: 'Apprentice',
                    builder: 'Builder',
                    client: 'Client',
                    commissionRate: 'Taux de commission (%) :',
                    memberSince: 'Membre depuis :',
                    currentTeamMember: 'Fait actuellement partie de l\'équipe :',
                    currentTeamMemberYes: 'Oui',
                    currentTeamMemberNo: 'Non',
                    inactiveTeamBadge: 'Hors équipe',
                    isCompany: 'Est-ce une entreprise ?',
                    iban: 'IBAN :',
                    country: 'Pays :',
                    address: 'Adresse :',
                    companyName: 'Nom de l\'entreprise :',
                    addAgent: '➕ Ajouter l\'Agent',
                    editAgent: '💾 Modifier l\'Agent',
                    reset: '🔄 Réinitialiser',
                    buildersManagers: 'Apprentices / Builders / Managers',
                    clients: 'Clients',
                    noAgents: 'Aucun agent enregistré.',
                    payment: 'Paiement',
                    portfolio: 'PF',
                    commissionRateShort: 'Taux de commission',
                    memberSinceShort: 'Membre depuis',
                    companyShort: 'Entreprise',
                    paymentTypeSelect: 'Sélectionner',
                    paymentDetails: 'Détails :',
                    paymentDetailsPlaceholder: 'Sélectionnez d\'abord un type',
                    paymentBankType: 'Type de banque (ex: Revolut, BNP, etc.) :',
                    paymentBankPlaceholder: 'Revolut, BNP, Crédit Agricole, etc.',
                    paymentPaypal: 'Email PayPal :',
                    paymentPaypalPlaceholder: 'exemple@email.com',
                    paymentOtherPlaceholder: 'Précisez le moyen de paiement',
                    removePayment: '🗑️ Supprimer',
                    engagement: {
                        sectionTitle: 'Suivi d’activité & incidents',
                        rulesHint: 'Fenêtre glissante : {days} jours. Statut selon le nombre d’incidents : 0–1 actif, 2–3 à surveiller, 4–5 avertissement, 6 ou plus sanction à envisager. Chaque enregistrement compte pour 1.',
                        selectAgent: 'Choisir un agent…',
                        agentLabel: 'Agent',
                        typeLabel: 'Type d’incident',
                        noteLabel: 'Détail (optionnel)',
                        notePlaceholder: 'ex. réunion hebdo du 12/05',
                        dateLabel: 'Date de l’incident (optionnel)',
                        refLabel: 'Réf. anti-doublon (optionnel)',
                        refPlaceholder: 'ex. poll_2026q1',
                        submit: 'Enregistrer l’incident',
                        incidentCount: '{count} incident(s) sur {days} j',
                        periodFrom: 'Depuis le {date}',
                        status: {
                            active: 'Actif',
                            attention: 'À surveiller',
                            warn: 'Avertissement',
                            sanction: 'Sanction à envisager'
                        },
                        types: {
                            meeting_absence: 'Réunion / meeting non rejoint',
                            survey_no_response: 'Sondage sans réponse',
                            task_missed: 'Participation / tâche manquée',
                            other_inactivity: 'Autre inactivité'
                        },
                        eventSaved: 'Incident enregistré. Le statut de l’agent a été mis à jour.',
                        eventFailed: 'Enregistrement impossible : {error}'
                    }
                },
                analyst: {
                    title: '📊 Data Analyst',
                    subtitle: 'Rentrées, sorties, CA, dépenses et répartition par builder/manager.',
                    expenses: 'Dépenses',
                    expenseLabel: 'Libellé',
                    expenseLabelPlaceholder: 'ex: Axiom',
                    expenseAmount: 'Montant',
                    expenseAmountPlaceholder: '25',
                    expenseCurrency: 'Devise',
                    expenseDate: 'Date',
                    expenseAdd: '➕ Ajouter',
                    allTransactions: 'Toutes les transactions',
                    allTransactionsHint: 'Entrées et sorties. Tri par type ci-dessous.',
                    filter: 'Filtrer :',
                    filterAll: 'Tout',
                    filterCommission: 'Commissions (entrées)',
                    filterExpense: 'Dépenses',
                    filterBuilder: 'Builders (paiements)',
                    filterManager: 'Managers (paiements)',
                    filterClient: 'Par client',
                    filterClientPlaceholder: '-- Client --',
                    monthlyRevenue: 'Chiffre d\'affaires par mois',
                    revenueByAgent: 'CA par builder / manager',
                    detailByAgent: 'Détail par agent (builders & managers)'
                },
                users: {
                    createTitle: 'Créer un utilisateur',
                    editTitle: 'Modifier un utilisateur',
                    listTitle: 'Liste des utilisateurs',
                    name: 'Nom',
                    email: 'Email',
                    password: 'Mot de passe',
                    passwordHelpCreate: 'Obligatoire à la création. En modification, laisse vide pour ne pas le changer.',
                    passwordHelpEdit: 'Laisse vide pour conserver le mot de passe actuel.',
                    role: 'Rôle',
                    status: 'Statut',
                    statusActive: 'Compte actif',
                    statusInactive: 'Compte désactivé',
                    assignedAgents: 'Agents assignés',
                    assignedAgentsHint: 'Utile surtout pour les builders: cela limite les agents et commissions visibles.',
                    create: '➕ Créer l\'utilisateur',
                    update: '💾 Modifier l\'utilisateur',
                    reset: '🔄 Réinitialiser',
                    noUsers: 'Aucun utilisateur enregistré.',
                    restricted: 'Seuls les admins et superadmins peuvent gérer les utilisateurs.',
                    assignedAgentsTitle: 'Agents assignés',
                    noAssignedAgents: 'Aucun agent assigné.',
                    userEmail: 'Email',
                    userRole: 'Rôle',
                    userStatus: 'Statut',
                    lastLogin: 'Dernière connexion',
                    recentLogins: 'Connexions récentes au site',
                    noLoginHistory: 'Aucune connexion enregistrée pour le moment.',
                    siteLoginLine: 'Connexion au site le {date}',
                    seeMoreLogins: 'Voir plus',
                    seeLessLogins: 'Voir moins',
                    ipAddress: 'IP',
                    device: 'Appareil',
                    unknownDevice: 'Appareil non renseigné',
                    edit: '✏️ Modifier',
                    deactivate: 'Désactiver',
                    reactivate: 'Réactiver'
                },
                account: {
                    tab: 'Mon compte',
                    title: 'Mon compte agent',
                    subtitle: 'Modifiez ici votre Discord, votre portfolio, vos moyens de paiement et votre mot de passe. Le pseudo reste fixe.',
                    empty: 'Aucun profil agent n’est lié à ce compte.',
                    pseudo: 'Pseudo (IGN)',
                    email: 'Email de connexion',
                    discord: 'Discord',
                    portfolio: 'Portfolio',
                    paymentMethods: 'Moyens de paiement',
                    addPaymentMethod: '➕ Ajouter un moyen de paiement',
                    save: '💾 Enregistrer mes informations',
                    passwordTitle: 'Changer mon mot de passe',
                    currentPassword: 'Mot de passe actuel',
                    newPassword: 'Nouveau mot de passe',
                    updatePassword: '🔐 Mettre à jour le mot de passe'
                },
                todos: {
                    tab: 'Todo List',
                    createTitle: 'Créer une tâche',
                    editTitle: 'Modifier une tâche',
                    summaryTotal: 'Total',
                    summaryOverdue: 'En retard',
                    summaryDueToday: 'Attention aujourd\'hui',
                    summaryArchived: 'Archivées',
                    title: 'Titre',
                    titlePlaceholder: 'Ex: Finaliser les paiements de mars',
                    status: 'Statut',
                    todo: 'À faire',
                    in_progress: 'En cours',
                    done: 'Terminé',
                    search: 'Recherche',
                    searchPlaceholder: 'Titre, description, assignation...',
                    filterStatus: 'Statut',
                    filterAllStatuses: 'Tous les statuts',
                    filterAssignee: 'Assigné à',
                    filterAllAssignees: 'Toutes les assignations',
                    filterArchived: 'Afficher aussi les archivées',
                    filterOverdue: 'Afficher seulement les retards',
                    sortBy: 'Tri',
                    sortDeadline: 'Deadline proche',
                    sortUpdated: 'Dernière mise à jour',
                    sortCreated: 'Création récente',
                    clearFilters: 'Effacer les filtres',
                    resultsLabel: '{visible} sur {total} tâches affichées',
                    noResults: 'Aucune tâche ne correspond aux filtres actuels.',
                    columnEmpty: 'Aucune tâche dans cette colonne.',
                    overdueBadge: 'En retard',
                    updatedAt: 'Maj: {date}',
                    changeStatus: 'Changer le statut',
                    assignedTo: 'Assigné à',
                    assignedToPlaceholder: 'Ex: Antoine / Manager / Builder Team',
                    deadline: 'Deadline',
                    deadlineTime: 'Heure',
                    description: 'Description',
                    descriptionPlaceholder: 'Contexte, blocages, prochaine action...',
                    add: '➕ Ajouter la tâche',
                    update: '💾 Modifier la tâche',
                    reset: '🔄 Réinitialiser',
                    teamTitle: 'Suivi de l’équipe',
                    teamSubtitle: 'Un espace partagé pour suivre l’avancement, les deadlines et les blocages.',
                    empty: 'Aucune tâche partagée pour le moment.',
                    createdBy: 'Créé par {name}',
                    updatedBy: 'Dernière maj: {name}',
                    deadlineLabel: 'Deadline: {date}',
                    assignedLabel: 'Assigné à: {name}',
                    edit: '✏️ Modifier',
                    archive: 'Archiver',
                    restore: 'Désarchiver',
                    moveTodo: 'À faire',
                    moveInProgress: 'En cours',
                    moveDone: 'Terminé',
                    delete: '🗑️ Supprimer'
                },
                data: {
                    title: 'Gestion des Données',
                    storageTitle: '📍 Où sont stockées les données ?',
                    storageStrong: 'Les données sont stockées dans MongoDB via l\'API du serveur.',
                    storageMeaning: 'Cela signifie que :',
                    storage1: 'Les données sont centralisées sur le serveur',
                    storage2: 'Elles sont partagées entre les navigateurs et les machines autorisés',
                    storage3: 'Le navigateur ne conserve plus la base métier localement',
                    storage4: 'Les suppressions passent désormais par l\'API et la base MongoDB',
                    storageWarn: '⚠️ Important : Gardez quand même des exports JSON réguliers pour vos sauvegardes d\'urgence.',
                    stats: 'Statistiques :',
                    statsAgents: 'Agents :',
                    statsCommissions: 'Commissions :',
                    statsTodos: 'Tâches :',
                    statsStorage: 'Stockage :',
                    exportTitle: '💾 Export des Données',
                    exportHint: 'Téléchargez toutes vos données dans un fichier JSON pour les sauvegarder.',
                    exportAll: '📥 Exporter toutes les données',
                    exportAgents: '👥 Exporter uniquement les agents',
                    exportCommissions: '📋 Exporter uniquement les commissions',
                    importTitle: '📤 Import des Données',
                    importHint: 'Importez des données depuis un fichier JSON précédemment exporté.',
                    importFile: 'Sélectionner un fichier JSON :',
                    importButton: '📤 Importer les données',
                    clearButton: '🗑️ Supprimer toutes les données',
                    storageRemote: 'MongoDB (serveur)',
                    storageLoggedOut: 'Session non connectée'
                },
                alerts: {
                    permissionTodos: 'Seuls les builders et plus peuvent gérer les tâches.',
                    permissionUsers: 'Seuls les admins et superadmins peuvent gérer les utilisateurs.',
                    permissionUserSuperadmin: 'Seul un superadmin peut modifier ce compte.',
                    permissionAgents: 'Seuls les managers et plus peuvent gérer les agents.',
                    permissionExpenses: 'Seuls les managers et plus peuvent gérer les dépenses.',
                    expenseLabelRequired: 'Veuillez saisir un libellé.',
                    expenseAmountRequired: 'Veuillez saisir un montant valide.',
                    expenseCreateFailed: 'Impossible d\'ajouter la dépense : {error}',
                    expenseDeleteFailed: 'Impossible de supprimer la dépense : {error}',
                    userPasswordRequired: 'Le mot de passe est obligatoire à la création.',
                    userNameEmailRequired: 'Veuillez remplir le nom et l’email.',
                    userUpdated: 'Utilisateur mis à jour avec succès.',
                    userCreated: 'Utilisateur créé avec succès.',
                    userSaveFailed: 'Impossible d\'enregistrer l\'utilisateur : {error}',
                    userStatusFailed: 'Impossible de mettre à jour le statut : {error}',
                    todoTitleRequired: 'Veuillez saisir un titre pour la tâche.',
                    todoCreated: 'Tâche créée avec succès.',
                    todoUpdated: 'Tâche mise à jour avec succès.',
                    todoDeleteConfirm: 'Supprimer cette tâche ?',
                    todoDeleteFailed: 'Impossible de supprimer la tâche : {error}',
                    todoStatusFailed: 'Impossible de mettre à jour le statut : {error}',
                    todoSaveFailed: 'Impossible d\'enregistrer la tâche : {error}',
                    todoArchiveFailed: 'Impossible de mettre à jour l\'archivage : {error}',
                    authLoginRequired: 'Veuillez saisir votre email et votre mot de passe.',
                    authLoginFailed: 'Impossible de se connecter : {error}',
                    apiNetworkHint: 'API utilisée : {api}\n— Vérifiez FRONTEND_URL sur le backend (origine exacte de cette page, plusieurs valeurs possibles séparées par des virgules).\n— Ou ouvrez le site avec ?apiBase=https://votre-serveur/api',
                    authDenied: 'Connexion refusée.',
                    authInProgress: 'Connexion en cours...',
                    showcaseCopied: 'Texte showcase copié !',
                    showcaseNotCopied: 'Impossible de copier automatiquement le texte showcase.',
                    showcaseCopyFailed: 'Impossible de copier le texte showcase : {error}',
                    genericConfirmDelete: 'Êtes-vous sûr de vouloir supprimer cette commission ?',
                    clientPseudoRequired: 'Veuillez saisir le pseudo du client.',
                    clientDiscordRequired: 'Veuillez saisir le Discord du client.',
                    clientExists: 'Un client avec ce pseudo existe déjà.',
                    agentUpdated: 'Agent modifié avec succès !',
                    agentCreated: 'Agent ajouté avec succès !',
                    agentSaveFailed: 'Impossible d\'enregistrer l\'agent : {error}',
                    agentDeleteFailed: 'Impossible de supprimer l\'agent : {error}',
                    agentCreatedWithCredentials: 'Agent ajouté avec succès !\n\nEmail : {email}\nMot de passe temporaire : {password}\n\nIl pourra modifier son mot de passe lui-même depuis son compte.',
                    worldPrefixRequired: '⚠️ Le nom du monde doit commencer par « c- ».',
                    noTransactions: 'Aucune transaction.',
                    noExpenses: 'Aucune dépense enregistrée.',
                    accountLoadFailed: 'Impossible de charger le compte agent : {error}',
                    accountSaveFailed: 'Impossible d\'enregistrer le compte : {error}',
                    accountSaved: 'Compte agent mis a jour avec succes.',
                    passwordChangeFailed: 'Impossible de changer le mot de passe : {error}',
                    passwordChanged: 'Mot de passe mis a jour avec succes.',
                    passwordFieldsRequired: 'Veuillez remplir les deux champs de mot de passe.'
                }
            },
            en: {
                header: {
                    title: '🏗️ Commission Manager',
                    subtitleLoggedOut: 'Sign in to load data from the MongoDB API.',
                    subtitleLoggedIn: 'Data loaded from MongoDB through the server API.',
                    language: 'Language',
                    emailPlaceholder: 'Email',
                    passwordPlaceholder: 'Password',
                    login: 'Sign in',
                    logout: 'Sign out',
                    noSession: 'No active session.',
                    connectedTo: 'Connected to {api}'
                },
                roles: { guest: 'Guest', builder: 'Builder', manager: 'Manager', admin: 'Admin', superadmin: 'Superadmin' },
                tabs: {
                    list: 'Commissions',
                    agentsManage: 'Manage Agents',
                    agentsList: 'Agents',
                    users: 'Users',
                    todos: 'Todo List',
                    account: 'My account',
                    analyst: 'Analytics',
                    data: 'Data'
                },
                common: {
                    yes: 'Yes', no: 'No', cancel: 'Cancel', add: 'Add', edit: 'Edit', delete: 'Delete', reset: 'Reset',
                    save: 'Save', select: 'Select', none: 'None', statusActive: 'Active', statusInactive: 'Disabled', never: 'Never'
                    , deletedSuccess: 'Deleted successfully.'
                },
                commissions: {
                    listTitle: 'Commissions',
                    new: '➕ New commission',
                    back: '← Back to list',
                    buildInfo: 'Build Information',
                    buildSize: 'Build size:',
                    buildName: 'Build name:',
                    worldName: 'World name:',
                    worldNameHint: 'Required, must start with "c-".',
                    description: 'Request description:',
                    descriptionPlaceholder: 'Describe the request',
                    version: 'Version:',
                    selectVersion: 'Select a version',
                    priceDistribution: 'Price Distribution',
                    priceDistributionHint: 'Split (€) = full share. % = fee paid by the agent. Total price = sum of all splits. Fee is prefilled from the agent rate.',
                    selectAgents: 'Select agents:',
                    whoTookWhat: 'Who gets what?',
                    dates: 'Dates',
                    buildStart: 'Build start:',
                    buildEnd: 'Build completed:',
                    payment: 'Payment',
                    depositPaid: 'Was the deposit paid?',
                    depositAmount: 'Deposit received (€)',
                    depositPlaceholder: 'Total price / 2',
                    depositHint: 'Default: total price / 2. For active commissions, only the deposit is counted in Analytics.',
                    buildTypeTitle: 'Build Type',
                    buildTypeQuestion: 'Base build or modification?',
                    baseBuild: 'Base build',
                    modification: 'Modification',
                    organics: 'Organics?',
                    client: 'Client',
                    clientName: 'Client name:',
                    selectClient: 'Select a client',
                    createClient: '➕ Create client',
                    newClient: 'New client',
                    clientPseudo: 'Nickname (IGN):',
                    clientPseudoPlaceholder: 'Client nickname',
                    clientDiscord: 'Discord:',
                    clientDiscordPlaceholder: 'Client Discord',
                    addClient: 'Add client',
                    feedbackQuestion: 'Did the client leave feedback?',
                    feedbackLabel: 'Client feedback:',
                    feedbackPlaceholder: 'Client feedback',
                    renderSection: 'Render',
                    renderLabel: 'Render:',
                    renderPlaceholder: 'Render URL or path',
                    saveNew: '💾 Save commission',
                    saveEdit: '💾 Update commission',
                    reset: '🔄 Reset',
                    empty: 'No commission recorded.',
                    finished: '✓ Completed',
                    inProgress: 'In progress',
                    copyShowcase: '📋 Copy showcase',
                    edit: '✏️ Edit',
                    delete: '🗑️ Delete',
                    infoSize: 'Size',
                    infoWorld: 'World',
                    infoClient: 'Client',
                    infoRealizedBy: 'Built by',
                    infoVersion: 'Version',
                    infoStart: 'Start',
                    infoEnd: 'End',
                    generatedPrice: 'Calculated total price: {price} €',
                    showcaseCopied: 'The showcase text was copied to the clipboard.',
                    showcaseNotCopied: 'The showcase text could not be copied automatically.'
                },
                agents: {
                    addTitle: 'Add an Agent',
                    listTitle: 'Agent List',
                    pseudo: 'Nickname (IGN):',
                    discord: 'Discord:',
                    paymentMethods: 'Payment methods:',
                    addPaymentMethod: '➕ Add a payment method',
                    pf: 'Portfolio (if any):',
                    pfPlaceholder: 'Portfolio',
                    category: 'Category:',
                    selectCategory: 'Select',
                    manager: 'Manager',
                    apprentice: 'Apprentice',
                    builder: 'Builder',
                    client: 'Client',
                    commissionRate: 'Commission rate (%):',
                    memberSince: 'Member since:',
                    currentTeamMember: 'Currently part of the team:',
                    currentTeamMemberYes: 'Yes',
                    currentTeamMemberNo: 'No',
                    inactiveTeamBadge: 'No longer in team',
                    isCompany: 'Is it a company?',
                    iban: 'IBAN:',
                    country: 'Country:',
                    address: 'Address:',
                    companyName: 'Company name:',
                    addAgent: '➕ Add Agent',
                    editAgent: '💾 Update Agent',
                    reset: '🔄 Reset',
                    buildersManagers: 'Apprentices / Builders / Managers',
                    clients: 'Clients',
                    noAgents: 'No agent recorded.',
                    payment: 'Payment',
                    portfolio: 'Portfolio',
                    commissionRateShort: 'Commission rate',
                    memberSinceShort: 'Member since',
                    companyShort: 'Company',
                    paymentTypeSelect: 'Select',
                    paymentDetails: 'Details:',
                    paymentDetailsPlaceholder: 'Select a type first',
                    paymentBankType: 'Bank type (ex: Revolut, BNP, etc.):',
                    paymentBankPlaceholder: 'Revolut, BNP, Crédit Agricole, etc.',
                    paymentPaypal: 'PayPal email:',
                    paymentPaypalPlaceholder: 'example@email.com',
                    paymentOtherPlaceholder: 'Specify the payment method',
                    removePayment: '🗑️ Remove',
                    engagement: {
                        sectionTitle: 'Activity & incidents',
                        rulesHint: 'Rolling window: {days} days. Status from incident count: 0–1 active, 2–3 watch, 4–5 warning, 6+ consider sanction. Each logged item counts as 1.',
                        selectAgent: 'Select an agent…',
                        agentLabel: 'Agent',
                        typeLabel: 'Incident type',
                        noteLabel: 'Details (optional)',
                        notePlaceholder: 'e.g. weekly meeting May 12',
                        dateLabel: 'Incident date (optional)',
                        refLabel: 'Dedup reference (optional)',
                        refPlaceholder: 'e.g. poll_2026q1',
                        submit: 'Log incident',
                        incidentCount: '{count} incident(s) in {days}d',
                        periodFrom: 'Since {date}',
                        status: {
                            active: 'Active',
                            attention: 'Watch',
                            warn: 'Warning',
                            sanction: 'Sanction review'
                        },
                        types: {
                            meeting_absence: 'Missed meeting',
                            survey_no_response: 'Survey not answered',
                            task_missed: 'Missed task / participation',
                            other_inactivity: 'Other inactivity'
                        },
                        eventSaved: 'Incident saved. The agent status was updated.',
                        eventFailed: 'Could not save: {error}'
                    }
                },
                analyst: {
                    title: '📊 Analytics',
                    subtitle: 'Income, expenses, revenue, costs, and split by builder/manager.',
                    expenses: 'Expenses',
                    expenseLabel: 'Label',
                    expenseLabelPlaceholder: 'e.g. Axiom',
                    expenseAmount: 'Amount',
                    expenseAmountPlaceholder: '25',
                    expenseCurrency: 'Currency',
                    expenseDate: 'Date',
                    expenseAdd: '➕ Add',
                    allTransactions: 'All transactions',
                    allTransactionsHint: 'Incoming and outgoing flows. Filter by type below.',
                    filter: 'Filter:',
                    filterAll: 'All',
                    filterCommission: 'Commissions (income)',
                    filterExpense: 'Expenses',
                    filterBuilder: 'Builders (payments)',
                    filterManager: 'Managers (payments)',
                    filterClient: 'By client',
                    filterClientPlaceholder: '-- Client --',
                    monthlyRevenue: 'Revenue by month',
                    revenueByAgent: 'Revenue by builder / manager',
                    detailByAgent: 'Breakdown by agent (builders & managers)'
                },
                users: {
                    createTitle: 'Create user',
                    editTitle: 'Edit user',
                    listTitle: 'User list',
                    name: 'Name',
                    email: 'Email',
                    password: 'Password',
                    passwordHelpCreate: 'Required on creation. Leave empty during edit to keep the current password.',
                    passwordHelpEdit: 'Leave empty to keep the current password.',
                    role: 'Role',
                    status: 'Status',
                    statusActive: 'Active account',
                    statusInactive: 'Disabled account',
                    assignedAgents: 'Assigned agents',
                    assignedAgentsHint: 'Mostly useful for builders: it limits the agents and commissions they can see.',
                    create: '➕ Create user',
                    update: '💾 Update user',
                    reset: '🔄 Reset',
                    noUsers: 'No user recorded.',
                    restricted: 'Only admins and superadmins can manage users.',
                    assignedAgentsTitle: 'Assigned agents',
                    noAssignedAgents: 'No assigned agents.',
                    userEmail: 'Email',
                    userRole: 'Role',
                    userStatus: 'Status',
                    lastLogin: 'Last login',
                    recentLogins: 'Recent site logins',
                    noLoginHistory: 'No login recorded yet.',
                    siteLoginLine: 'Signed in to the site at {date}',
                    seeMoreLogins: 'See more',
                    seeLessLogins: 'See less',
                    ipAddress: 'IP',
                    device: 'Device',
                    unknownDevice: 'Unknown device',
                    edit: '✏️ Edit',
                    deactivate: 'Disable',
                    reactivate: 'Reactivate'
                },
                account: {
                    tab: 'My account',
                    title: 'My agent account',
                    subtitle: 'Update your Discord, portfolio, payment methods, and password here. Your nickname stays fixed.',
                    empty: 'No agent profile is linked to this account.',
                    pseudo: 'Nickname (IGN)',
                    email: 'Login email',
                    discord: 'Discord',
                    portfolio: 'Portfolio',
                    paymentMethods: 'Payment methods',
                    addPaymentMethod: '➕ Add a payment method',
                    save: '💾 Save my details',
                    passwordTitle: 'Change my password',
                    currentPassword: 'Current password',
                    newPassword: 'New password',
                    updatePassword: '🔐 Update password'
                },
                todos: {
                    tab: 'Todo List',
                    createTitle: 'Create task',
                    editTitle: 'Edit task',
                    summaryTotal: 'Total',
                    summaryOverdue: 'Overdue',
                    summaryDueToday: 'Due today alert',
                    summaryArchived: 'Archived',
                    title: 'Title',
                    titlePlaceholder: 'E.g. Finalize March payments',
                    status: 'Status',
                    todo: 'To do',
                    in_progress: 'In progress',
                    done: 'Done',
                    search: 'Search',
                    searchPlaceholder: 'Title, description, assignee...',
                    filterStatus: 'Status',
                    filterAllStatuses: 'All statuses',
                    filterAssignee: 'Assigned to',
                    filterAllAssignees: 'All assignees',
                    filterArchived: 'Show archived too',
                    filterOverdue: 'Show overdue only',
                    sortBy: 'Sort by',
                    sortDeadline: 'Closest deadline',
                    sortUpdated: 'Latest update',
                    sortCreated: 'Recently created',
                    clearFilters: 'Clear filters',
                    resultsLabel: '{visible} of {total} tasks shown',
                    noResults: 'No tasks match the current filters.',
                    columnEmpty: 'No task in this column.',
                    overdueBadge: 'Overdue',
                    updatedAt: 'Updated: {date}',
                    changeStatus: 'Change status',
                    assignedTo: 'Assigned to',
                    assignedToPlaceholder: 'E.g. Antoine / Manager / Builder Team',
                    deadline: 'Deadline',
                    deadlineTime: 'Time',
                    description: 'Description',
                    descriptionPlaceholder: 'Context, blockers, next action...',
                    add: '➕ Add task',
                    update: '💾 Update task',
                    reset: '🔄 Reset',
                    teamTitle: 'Team follow-up',
                    teamSubtitle: 'A shared space to track progress, deadlines, and blockers.',
                    empty: 'No shared task yet.',
                    createdBy: 'Created by {name}',
                    updatedBy: 'Last update: {name}',
                    deadlineLabel: 'Deadline: {date}',
                    assignedLabel: 'Assigned to: {name}',
                    edit: '✏️ Edit',
                    archive: 'Archive',
                    restore: 'Unarchive',
                    moveTodo: 'To do',
                    moveInProgress: 'In progress',
                    moveDone: 'Done',
                    delete: '🗑️ Delete'
                },
                data: {
                    title: 'Data',
                    storageTitle: '📍 Where is the data stored?',
                    storageStrong: 'Data is stored in MongoDB through the server API.',
                    storageMeaning: 'This means:',
                    storage1: 'Data is centralized on the server',
                    storage2: 'It is shared across authorized browsers and devices',
                    storage3: 'The browser no longer keeps the business database locally',
                    storage4: 'Deletes now go through the API and MongoDB',
                    storageWarn: '⚠️ Important: keep regular JSON exports as emergency backups.',
                    stats: 'Statistics:',
                    statsAgents: 'Agents:',
                    statsCommissions: 'Commissions:',
                    statsTodos: 'Tasks:',
                    statsStorage: 'Storage:',
                    exportTitle: '💾 Export Data',
                    exportHint: 'Download all your data to a JSON file for backup.',
                    exportAll: '📥 Export all data',
                    exportAgents: '👥 Export agents only',
                    exportCommissions: '📋 Export commissions only',
                    importTitle: '📤 Import Data',
                    importHint: 'Import data from a previously exported JSON file.',
                    importFile: 'Select a JSON file:',
                    importButton: '📤 Import data',
                    clearButton: '🗑️ Delete all data',
                    storageRemote: 'MongoDB (server)',
                    storageLoggedOut: 'No active session'
                },
                alerts: {
                    permissionTodos: 'Only builders and above can manage tasks.',
                    permissionUsers: 'Only admins and superadmins can manage users.',
                    permissionUserSuperadmin: 'Only a superadmin can edit this account.',
                    permissionAgents: 'Only managers and above can manage agents.',
                    permissionExpenses: 'Only managers and above can manage expenses.',
                    expenseLabelRequired: 'Please enter a label.',
                    expenseAmountRequired: 'Please enter a valid amount.',
                    expenseCreateFailed: 'Unable to add the expense: {error}',
                    expenseDeleteFailed: 'Unable to delete the expense: {error}',
                    userPasswordRequired: 'Password is required when creating a user.',
                    userNameEmailRequired: 'Please fill in the name and email.',
                    userUpdated: 'User updated successfully.',
                    userCreated: 'User created successfully.',
                    userSaveFailed: 'Unable to save the user: {error}',
                    userStatusFailed: 'Unable to update the status: {error}',
                    todoTitleRequired: 'Please enter a task title.',
                    todoCreated: 'Task created successfully.',
                    todoUpdated: 'Task updated successfully.',
                    todoDeleteConfirm: 'Delete this task?',
                    todoDeleteFailed: 'Unable to delete the task: {error}',
                    todoStatusFailed: 'Unable to update the status: {error}',
                    todoSaveFailed: 'Unable to save the task: {error}',
                    todoArchiveFailed: 'Unable to update the archive state: {error}',
                    authLoginRequired: 'Please enter your email and password.',
                    authLoginFailed: 'Unable to sign in: {error}',
                    apiNetworkHint: 'API tried: {api}\n— Check FRONTEND_URL on the backend lists this page origin (comma-separated allowed).\n— Or open the site with ?apiBase=https://your-server/api',
                    authDenied: 'Login denied.',
                    authInProgress: 'Signing in...',
                    showcaseCopied: 'Showcase text copied!',
                    showcaseNotCopied: 'Unable to copy the showcase text automatically.',
                    showcaseCopyFailed: 'Unable to copy the showcase text: {error}',
                    genericConfirmDelete: 'Are you sure you want to delete this commission?',
                    clientPseudoRequired: 'Please enter the client nickname.',
                    clientDiscordRequired: 'Please enter the client Discord.',
                    clientExists: 'A client with this nickname already exists.',
                    agentUpdated: 'Agent updated successfully!',
                    agentCreated: 'Agent added successfully!',
                    agentSaveFailed: 'Unable to save the agent: {error}',
                    agentDeleteFailed: 'Unable to delete the agent: {error}',
                    agentCreatedWithCredentials: 'Agent added successfully!\n\nEmail: {email}\nTemporary password: {password}\n\nThey can change their password themselves from their account.',
                    worldPrefixRequired: '⚠️ The world name must start with "c-".',
                    noTransactions: 'No transaction.',
                    noExpenses: 'No expense recorded.',
                    accountLoadFailed: 'Unable to load the agent account: {error}',
                    accountSaveFailed: 'Unable to save the account: {error}',
                    accountSaved: 'Agent account updated successfully.',
                    passwordChangeFailed: 'Unable to change the password: {error}',
                    passwordChanged: 'Password updated successfully.',
                    passwordFieldsRequired: 'Please fill in both password fields.'
                }
            },
            de: {
                header: {
                    title: '🏗️ Commission Manager',
                    subtitleLoggedOut: 'Melde dich an, um die Daten über die MongoDB-API zu laden.',
                    subtitleLoggedIn: 'Daten wurden über die Server-API aus MongoDB geladen.',
                    language: 'Sprache',
                    emailPlaceholder: 'E-Mail',
                    passwordPlaceholder: 'Passwort',
                    login: 'Anmelden',
                    logout: 'Abmelden',
                    noSession: 'Keine aktive Sitzung.',
                    connectedTo: 'Verbunden mit {api}'
                },
                roles: { guest: 'Gast', builder: 'Builder', manager: 'Manager', admin: 'Admin', superadmin: 'Superadmin' },
                tabs: {
                    list: 'Aufträge',
                    agentsManage: 'Agenten verwalten',
                    agentsList: 'Agenten',
                    users: 'Benutzer',
                    todos: 'Aufgabenliste',
                    account: 'Mein Konto',
                    analyst: 'Analyse',
                    data: 'Daten'
                },
                common: {
                    yes: 'Ja', no: 'Nein', cancel: 'Abbrechen', add: 'Hinzufügen', edit: 'Bearbeiten', delete: 'Löschen',
                    reset: 'Zurücksetzen', save: 'Speichern', select: 'Auswählen', none: 'Keine', statusActive: 'Aktiv',
                    statusInactive: 'Deaktiviert', never: 'Nie', deletedSuccess: 'Erfolgreich gelöscht.'
                },
                commissions: {
                    listTitle: 'Aufträge',
                    new: '➕ Neuer Auftrag',
                    back: '← Zurück zur Liste',
                    buildInfo: 'Build-Informationen',
                    buildSize: 'Größe des Builds:',
                    buildName: 'Name des Builds:',
                    worldName: 'Weltenname:',
                    worldNameHint: 'Pflichtfeld, muss mit „c-“ beginnen.',
                    description: 'Beschreibung der Anfrage:',
                    descriptionPlaceholder: 'Anfrage beschreiben',
                    version: 'Version:',
                    selectVersion: 'Version auswählen',
                    priceDistribution: 'Preisverteilung',
                    priceDistributionHint: 'Verteilung (€) = voller Anteil. % = Gebühr, die der Agent zahlt. Gesamtpreis = Summe aller Anteile. Die Gebühr wird mit dem Satz des Agenten vorausgefüllt.',
                    selectAgents: 'Agenten auswählen:',
                    whoTookWhat: 'Wer bekommt wie viel?',
                    dates: 'Termine',
                    buildStart: 'Beginn:',
                    buildEnd: 'Fertiggestellt am:',
                    payment: 'Zahlung',
                    depositPaid: 'Wurde die Anzahlung bezahlt?',
                    depositAmount: 'Erhaltene Anzahlung (€)',
                    depositPlaceholder: 'Gesamtpreis / 2',
                    depositHint: 'Standard: Gesamtpreis / 2. Bei laufenden Aufträgen wird in der Analyse nur die Anzahlung berücksichtigt.',
                    buildTypeTitle: 'Build-Typ',
                    buildTypeQuestion: 'Basis-Build oder Änderung?',
                    baseBuild: 'Basis-Build',
                    modification: 'Änderung',
                    organics: 'Organics?',
                    client: 'Kunde',
                    clientName: 'Kundenname:',
                    selectClient: 'Kunden auswählen',
                    createClient: '➕ Kunden anlegen',
                    newClient: 'Neuer Kunde',
                    clientPseudo: 'Nickname (IGN):',
                    clientPseudoPlaceholder: 'Nickname des Kunden',
                    clientDiscord: 'Discord:',
                    clientDiscordPlaceholder: 'Discord des Kunden',
                    addClient: 'Kunden hinzufügen',
                    feedbackQuestion: 'Hat der Kunde Feedback gegeben?',
                    feedbackLabel: 'Kundenfeedback:',
                    feedbackPlaceholder: 'Kundenfeedback',
                    renderSection: 'Render',
                    renderLabel: 'Render:',
                    renderPlaceholder: 'Render-URL oder Pfad',
                    saveNew: '💾 Auftrag speichern',
                    saveEdit: '💾 Auftrag aktualisieren',
                    reset: '🔄 Zurücksetzen',
                    empty: 'Kein Auftrag vorhanden.',
                    finished: '✓ Abgeschlossen',
                    inProgress: 'In Arbeit',
                    copyShowcase: '📋 Showcase kopieren',
                    edit: '✏️ Bearbeiten',
                    delete: '🗑️ Löschen',
                    infoSize: 'Größe',
                    infoWorld: 'Welt',
                    infoClient: 'Kunde',
                    infoRealizedBy: 'Erstellt von',
                    infoVersion: 'Version',
                    infoStart: 'Start',
                    infoEnd: 'Ende',
                    generatedPrice: 'Berechneter Gesamtpreis: {price} €',
                    showcaseCopied: 'Der Showcase-Text wurde in die Zwischenablage kopiert.',
                    showcaseNotCopied: 'Der Showcase-Text konnte nicht automatisch kopiert werden.'
                },
                agents: {
                    addTitle: 'Agent hinzufügen',
                    listTitle: 'Agentenliste',
                    pseudo: 'Nickname (IGN):',
                    discord: 'Discord:',
                    paymentMethods: 'Zahlungsmethoden:',
                    addPaymentMethod: '➕ Zahlungsmethode hinzufügen',
                    pf: 'Portfolio (falls vorhanden):',
                    pfPlaceholder: 'Portfolio',
                    category: 'Kategorie:',
                    selectCategory: 'Auswählen',
                    manager: 'Manager',
                    apprentice: 'Apprentice',
                    builder: 'Builder',
                    client: 'Kunde',
                    commissionRate: 'Provisionssatz (%):',
                    memberSince: 'Mitglied seit:',
                    currentTeamMember: 'Aktuell im Team:',
                    currentTeamMemberYes: 'Ja',
                    currentTeamMemberNo: 'Nein',
                    inactiveTeamBadge: 'Nicht mehr im Team',
                    isCompany: 'Ist es ein Unternehmen?',
                    iban: 'IBAN:',
                    country: 'Land:',
                    address: 'Adresse:',
                    companyName: 'Firmenname:',
                    addAgent: '➕ Agent hinzufügen',
                    editAgent: '💾 Agent aktualisieren',
                    reset: '🔄 Zurücksetzen',
                    buildersManagers: 'Apprentices / Builder / Manager',
                    clients: 'Kunden',
                    noAgents: 'Keine Agenten vorhanden.',
                    payment: 'Zahlung',
                    portfolio: 'Portfolio',
                    commissionRateShort: 'Provisionssatz',
                    memberSinceShort: 'Mitglied seit',
                    companyShort: 'Unternehmen',
                    paymentTypeSelect: 'Auswählen',
                    paymentDetails: 'Details:',
                    paymentDetailsPlaceholder: 'Wähle zuerst einen Typ aus',
                    paymentBankType: 'Banktyp (z. B. Revolut, BNP usw.):',
                    paymentBankPlaceholder: 'Revolut, BNP, Crédit Agricole usw.',
                    paymentPaypal: 'PayPal-E-Mail:',
                    paymentPaypalPlaceholder: 'beispiel@email.com',
                    paymentOtherPlaceholder: 'Zahlungsmethode angeben',
                    removePayment: '🗑️ Entfernen',
                    engagement: {
                        sectionTitle: 'Aktivität & Vorfälle',
                        rulesHint: 'Zeitfenster: {days} Tage. Status nach Anzahl: 0–1 aktiv, 2–3 beobachten, 4–5 Verwarnung, 6+ Sanktion prüfen. Jeder Eintrag zählt 1.',
                        selectAgent: 'Agent wählen…',
                        agentLabel: 'Agent',
                        typeLabel: 'Vorfall-Typ',
                        noteLabel: 'Detail (optional)',
                        notePlaceholder: 'z. B. Weekly am 12.05.',
                        dateLabel: 'Datum des Vorfalls (optional)',
                        refLabel: 'Referenz gegen Dubletten (optional)',
                        refPlaceholder: 'z. B. poll_2026q1',
                        submit: 'Vorfall speichern',
                        incidentCount: '{count} Vorfall/Vorfälle in {days} T.',
                        periodFrom: 'Seit {date}',
                        status: {
                            active: 'Aktiv',
                            attention: 'Beobachten',
                            warn: 'Verwarnung',
                            sanction: 'Sanktion prüfen'
                        },
                        types: {
                            meeting_absence: 'Meeting nicht besucht',
                            survey_no_response: 'Umfrage nicht beantwortet',
                            task_missed: 'Aufgabe / Teilnahme verpasst',
                            other_inactivity: 'Sonstige Inaktivität'
                        },
                        eventSaved: 'Vorfall gespeichert. Status wurde aktualisiert.',
                        eventFailed: 'Speichern fehlgeschlagen: {error}'
                    }
                },
                analyst: {
                    title: '📊 Analyse',
                    subtitle: 'Einnahmen, Ausgaben, Umsatz, Kosten und Aufteilung nach Builder/Manager.',
                    expenses: 'Ausgaben',
                    expenseLabel: 'Bezeichnung',
                    expenseLabelPlaceholder: 'z. B. Axiom',
                    expenseAmount: 'Betrag',
                    expenseAmountPlaceholder: '25',
                    expenseCurrency: 'Währung',
                    expenseDate: 'Datum',
                    expenseAdd: '➕ Hinzufügen',
                    allTransactions: 'Alle Transaktionen',
                    allTransactionsHint: 'Ein- und Ausgänge. Unten nach Typ filtern.',
                    filter: 'Filter:',
                    filterAll: 'Alle',
                    filterCommission: 'Aufträge (Einnahmen)',
                    filterExpense: 'Ausgaben',
                    filterBuilder: 'Builder (Auszahlungen)',
                    filterManager: 'Manager (Auszahlungen)',
                    filterClient: 'Nach Kunde',
                    filterClientPlaceholder: '-- Kunde --',
                    monthlyRevenue: 'Umsatz pro Monat',
                    revenueByAgent: 'Umsatz pro Builder / Manager',
                    detailByAgent: 'Details pro Agent (Builder & Manager)'
                },
                users: {
                    createTitle: 'Benutzer anlegen',
                    editTitle: 'Benutzer bearbeiten',
                    listTitle: 'Benutzerliste',
                    name: 'Name',
                    email: 'E-Mail',
                    password: 'Passwort',
                    passwordHelpCreate: 'Beim Anlegen erforderlich. Beim Bearbeiten leer lassen, um das aktuelle Passwort zu behalten.',
                    passwordHelpEdit: 'Leer lassen, um das aktuelle Passwort zu behalten.',
                    role: 'Rolle',
                    status: 'Status',
                    statusActive: 'Aktives Konto',
                    statusInactive: 'Deaktiviertes Konto',
                    assignedAgents: 'Zugewiesene Agenten',
                    assignedAgentsHint: 'Vor allem für Builder nützlich: Dadurch werden sichtbare Agenten und Aufträge eingeschränkt.',
                    create: '➕ Benutzer anlegen',
                    update: '💾 Benutzer aktualisieren',
                    reset: '🔄 Zurücksetzen',
                    noUsers: 'Keine Benutzer vorhanden.',
                    restricted: 'Nur Admins und Superadmins können Benutzer verwalten.',
                    assignedAgentsTitle: 'Zugewiesene Agenten',
                    noAssignedAgents: 'Keine zugewiesenen Agenten.',
                    userEmail: 'E-Mail',
                    userRole: 'Rolle',
                    userStatus: 'Status',
                    lastLogin: 'Letzte Anmeldung',
                    recentLogins: 'Letzte Website-Anmeldungen',
                    noLoginHistory: 'Noch keine Verbindung protokolliert.',
                    siteLoginLine: 'Website-Anmeldung am {date}',
                    seeMoreLogins: 'Mehr anzeigen',
                    seeLessLogins: 'Weniger anzeigen',
                    ipAddress: 'IP',
                    device: 'Gerät',
                    unknownDevice: 'Unbekanntes Gerät',
                    edit: '✏️ Bearbeiten',
                    deactivate: 'Deaktivieren',
                    reactivate: 'Reaktivieren'
                },
                account: {
                    tab: 'Mein Konto',
                    title: 'Mein Agentenkonto',
                    subtitle: 'Hier kannst du Discord, Portfolio, Zahlungsmethoden und Passwort ändern. Der Nickname bleibt fest.',
                    empty: 'Mit diesem Konto ist kein Agentenprofil verknüpft.',
                    pseudo: 'Nickname (IGN)',
                    email: 'Login-E-Mail',
                    discord: 'Discord',
                    portfolio: 'Portfolio',
                    paymentMethods: 'Zahlungsmethoden',
                    addPaymentMethod: '➕ Zahlungsmethode hinzufügen',
                    save: '💾 Meine Daten speichern',
                    passwordTitle: 'Passwort ändern',
                    currentPassword: 'Aktuelles Passwort',
                    newPassword: 'Neues Passwort',
                    updatePassword: '🔐 Passwort aktualisieren'
                },
                todos: {
                    tab: 'Aufgabenliste',
                    createTitle: 'Aufgabe anlegen',
                    editTitle: 'Aufgabe bearbeiten',
                    summaryTotal: 'Gesamt',
                    summaryOverdue: 'Überfällig',
                    summaryDueToday: 'Heute fällig',
                    summaryArchived: 'Archiviert',
                    title: 'Titel',
                    titlePlaceholder: 'Z. B. März-Zahlungen finalisieren',
                    status: 'Status',
                    todo: 'Offen',
                    in_progress: 'In Arbeit',
                    done: 'Erledigt',
                    search: 'Suche',
                    searchPlaceholder: 'Titel, Beschreibung, Zuweisung...',
                    filterStatus: 'Status',
                    filterAllStatuses: 'Alle Status',
                    filterAssignee: 'Zugewiesen an',
                    filterAllAssignees: 'Alle Zuweisungen',
                    filterArchived: 'Archivierte auch anzeigen',
                    filterOverdue: 'Nur überfällige zeigen',
                    sortBy: 'Sortierung',
                    sortDeadline: 'Nächste Deadline',
                    sortUpdated: 'Letzte Änderung',
                    sortCreated: 'Neu erstellt',
                    clearFilters: 'Filter zurücksetzen',
                    resultsLabel: '{visible} von {total} Aufgaben angezeigt',
                    noResults: 'Keine Aufgabe passt zu den aktuellen Filtern.',
                    columnEmpty: 'Keine Aufgabe in dieser Spalte.',
                    overdueBadge: 'Überfällig',
                    updatedAt: 'Aktualisiert: {date}',
                    changeStatus: 'Status ändern',
                    assignedTo: 'Zugewiesen an',
                    assignedToPlaceholder: 'Z. B. Antoine / Manager / Builder Team',
                    deadline: 'Deadline',
                    deadlineTime: 'Uhrzeit',
                    description: 'Beschreibung',
                    descriptionPlaceholder: 'Kontext, Blocker, nächste Aktion...',
                    add: '➕ Aufgabe hinzufügen',
                    update: '💾 Aufgabe aktualisieren',
                    reset: '🔄 Zurücksetzen',
                    teamTitle: 'Team-Übersicht',
                    teamSubtitle: 'Ein gemeinsamer Bereich, um Fortschritt, Deadlines und Blocker zu verfolgen.',
                    empty: 'Noch keine gemeinsame Aufgabe vorhanden.',
                    createdBy: 'Erstellt von {name}',
                    updatedBy: 'Zuletzt geändert: {name}',
                    deadlineLabel: 'Deadline: {date}',
                    assignedLabel: 'Zugewiesen an: {name}',
                    edit: '✏️ Bearbeiten',
                    archive: 'Archivieren',
                    restore: 'Wiederherstellen',
                    moveTodo: 'Offen',
                    moveInProgress: 'In Arbeit',
                    moveDone: 'Erledigt',
                    delete: '🗑️ Löschen'
                },
                data: {
                    title: 'Daten',
                    storageTitle: '📍 Wo werden die Daten gespeichert?',
                    storageStrong: 'Die Daten werden über die Server-API in MongoDB gespeichert.',
                    storageMeaning: 'Das bedeutet:',
                    storage1: 'Die Daten sind zentral auf dem Server gespeichert',
                    storage2: 'Sie werden zwischen autorisierten Browsern und Geräten geteilt',
                    storage3: 'Der Browser speichert die Geschäftsdaten nicht mehr lokal',
                    storage4: 'Löschungen laufen jetzt über die API und MongoDB',
                    storageWarn: '⚠️ Wichtig: Behalte trotzdem regelmäßige JSON-Exporte als Notfall-Backups.',
                    stats: 'Statistiken:',
                    statsAgents: 'Agenten:',
                    statsCommissions: 'Aufträge:',
                    statsTodos: 'Aufgaben:',
                    statsStorage: 'Speicher:',
                    exportTitle: '💾 Daten exportieren',
                    exportHint: 'Lade alle Daten als JSON-Datei herunter, um ein Backup zu erstellen.',
                    exportAll: '📥 Alle Daten exportieren',
                    exportAgents: '👥 Nur Agenten exportieren',
                    exportCommissions: '📋 Nur Aufträge exportieren',
                    importTitle: '📤 Daten importieren',
                    importHint: 'Importiere Daten aus einer zuvor exportierten JSON-Datei.',
                    importFile: 'JSON-Datei auswählen:',
                    importButton: '📤 Daten importieren',
                    clearButton: '🗑️ Alle Daten löschen',
                    storageRemote: 'MongoDB (Server)',
                    storageLoggedOut: 'Keine aktive Sitzung'
                },
                alerts: {
                    permissionTodos: 'Nur Builder und höher können Aufgaben verwalten.',
                    permissionUsers: 'Nur Admins und Superadmins können Benutzer verwalten.',
                    permissionUserSuperadmin: 'Nur ein Superadmin kann dieses Konto bearbeiten.',
                    permissionAgents: 'Nur Manager und höher können Agenten verwalten.',
                    permissionExpenses: 'Nur Manager und höher können Ausgaben verwalten.',
                    expenseLabelRequired: 'Bitte gib eine Bezeichnung ein.',
                    expenseAmountRequired: 'Bitte gib einen gültigen Betrag ein.',
                    expenseCreateFailed: 'Ausgabe konnte nicht hinzugefügt werden: {error}',
                    expenseDeleteFailed: 'Ausgabe konnte nicht gelöscht werden: {error}',
                    userPasswordRequired: 'Beim Anlegen eines Benutzers ist ein Passwort erforderlich.',
                    userNameEmailRequired: 'Bitte Name und E-Mail ausfüllen.',
                    userUpdated: 'Benutzer erfolgreich aktualisiert.',
                    userCreated: 'Benutzer erfolgreich erstellt.',
                    userSaveFailed: 'Benutzer konnte nicht gespeichert werden: {error}',
                    userStatusFailed: 'Status konnte nicht aktualisiert werden: {error}',
                    todoTitleRequired: 'Bitte gib einen Titel für die Aufgabe ein.',
                    todoCreated: 'Aufgabe erfolgreich erstellt.',
                    todoUpdated: 'Aufgabe erfolgreich aktualisiert.',
                    todoDeleteConfirm: 'Diese Aufgabe löschen?',
                    todoDeleteFailed: 'Aufgabe konnte nicht gelöscht werden: {error}',
                    todoStatusFailed: 'Status konnte nicht aktualisiert werden: {error}',
                    todoSaveFailed: 'Aufgabe konnte nicht gespeichert werden: {error}',
                    todoArchiveFailed: 'Archivierungsstatus konnte nicht aktualisiert werden: {error}',
                    authLoginRequired: 'Bitte gib deine E-Mail und dein Passwort ein.',
                    authLoginFailed: 'Anmeldung fehlgeschlagen: {error}',
                    apiNetworkHint: 'API: {api}\n— FRONTEND_URL auf dem Server pruefen (exakte Origin, kommagetrennt erlaubt).\n— Oder ?apiBase=https://dein-server/api in der URL.',
                    authDenied: 'Anmeldung verweigert.',
                    authInProgress: 'Anmeldung läuft...',
                    showcaseCopied: 'Showcase-Text kopiert!',
                    showcaseNotCopied: 'Der Showcase-Text konnte nicht automatisch kopiert werden.',
                    showcaseCopyFailed: 'Der Showcase-Text konnte nicht kopiert werden: {error}',
                    genericConfirmDelete: 'Möchtest du diesen Auftrag wirklich löschen?',
                    clientPseudoRequired: 'Bitte gib den Nickname des Kunden ein.',
                    clientDiscordRequired: 'Bitte gib den Discord des Kunden ein.',
                    clientExists: 'Ein Kunde mit diesem Nickname existiert bereits.',
                    agentUpdated: 'Agent erfolgreich aktualisiert!',
                    agentCreated: 'Agent erfolgreich hinzugefügt!',
                    agentSaveFailed: 'Agent konnte nicht gespeichert werden: {error}',
                    agentDeleteFailed: 'Agent konnte nicht gelöscht werden: {error}',
                    agentCreatedWithCredentials: 'Agent erfolgreich hinzugefügt!\n\nE-Mail: {email}\nTemporäres Passwort: {password}\n\nDas Passwort kann später im eigenen Konto geändert werden.',
                    worldPrefixRequired: '⚠️ Der Weltenname muss mit „c-“ beginnen.',
                    noTransactions: 'Keine Transaktion.',
                    noExpenses: 'Keine Ausgabe vorhanden.',
                    accountLoadFailed: 'Das Agentenkonto konnte nicht geladen werden: {error}',
                    accountSaveFailed: 'Das Konto konnte nicht gespeichert werden: {error}',
                    accountSaved: 'Agentenkonto erfolgreich aktualisiert.',
                    passwordChangeFailed: 'Das Passwort konnte nicht geändert werden: {error}',
                    passwordChanged: 'Passwort erfolgreich aktualisiert.',
                    passwordFieldsRequired: 'Bitte fülle beide Passwortfelder aus.'
                }
            }
        };

        function getInitialLanguage() {
            const stored = window.localStorage.getItem('lusciana-language');
            if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
                return stored;
            }

            const browser = (navigator.language || 'fr').slice(0, 2).toLowerCase();
            return SUPPORTED_LANGUAGES.includes(browser) ? browser : 'fr';
        }

        function interpolate(template, params = {}) {
            return String(template).replace(/\{(\w+)\}/g, (_, key) => params[key] ?? '');
        }

        function t(key, params = {}) {
            const keys = key.split('.');
            let value = I18N[currentLanguage];
            for (const part of keys) {
                value = value?.[part];
            }
            if (value === undefined) {
                value = keys.reduce((acc, part) => acc?.[part], I18N.fr);
            }
            return interpolate(value ?? key, params);
        }

        function getRoleLabel(role) {
            if (role === 'client') {
                return t('agents.client');
            }
            if (role === 'apprentice') {
                return t('agents.apprentice');
            }
            return t(`roles.${role || 'guest'}`);
        }

        function setText(selector, key, params = {}) {
            const element = document.querySelector(selector);
            if (element) {
                element.textContent = t(key, params);
            }
        }

        function setPlaceholder(selector, key) {
            const element = document.querySelector(selector);
            if (element) {
                element.placeholder = t(key);
            }
        }

        function translateServerMessage(message) {
            const map = {
                'Identifiants invalides': 'alerts.authLoginFailed',
                'Permissions insuffisantes': 'alerts.permissionUsers',
                'Token manquant': 'alerts.authDenied',
            };
            const key = map[message];
            return key ? t(key, { error: message }) : message;
        }

        function applyStaticTranslations() {
            document.documentElement.lang = currentLanguage;
            const languageSelect = document.getElementById('languageSelect');
            if (languageSelect) {
                languageSelect.value = currentLanguage;
            }

            setText('#headerTitle', 'header.title');
            setText('#languageLabel', 'header.language');
            setPlaceholder('#loginEmail', 'header.emailPlaceholder');
            setPlaceholder('#loginPassword', 'header.passwordPlaceholder');
            setText('#loginForm button[type="submit"]', 'header.login');
            setText('#sessionInfo button.secondary', 'header.logout');
            setText('#tabListBtn', 'tabs.list');

            setText('#tabUsersBtn', 'tabs.users');
            setText('#tabTodosBtn', 'tabs.todos');
            setText('#tabAccountBtn', 'tabs.account');
            setText('#tabAnalystBtn', 'tabs.analyst');
            setText('#tabDataBtn', 'tabs.data');

            setText('#commissionListView > div h2', 'commissions.listTitle');
            setText('#newCommissionButton', 'commissions.new');
            setText('#commissionFormView button.secondary', 'commissions.back');
            setText('#commissionForm .form-section:nth-of-type(1) h2', 'commissions.buildInfo');
            setText('label[for="buildSize"]', 'commissions.buildSize');
            setText('label[for="buildName"]', 'commissions.buildName');
            setText('label[for="worldName"]', 'commissions.worldName');
            setText('#worldName + p', 'commissions.worldNameHint');
            setText('label[for="clientWants"]', 'commissions.description');
            setPlaceholder('#clientWants', 'commissions.descriptionPlaceholder');
            setText('label[for="version"]', 'commissions.version');
            setText('#version option[value=""]', 'commissions.selectVersion');
            setText('#commissionForm .form-group > label:not([for]):first-of-type', 'commissions.priceDistribution');
            setText('#commissionForm .form-group p', 'commissions.priceDistributionHint');
            setText('#commissionForm .form-group div label[style*="font-size: 14px"]', 'commissions.selectAgents');
            setText('#commissionForm .form-group h3', 'commissions.whoTookWhat');
            setText('#commissionForm .form-section:nth-of-type(2) h2', 'commissions.dates');
            setText('label[for="buildStart"]', 'commissions.buildStart');
            setText('label[for="buildEnd"]', 'commissions.buildEnd');
            setText('#commissionForm .form-section:nth-of-type(3) h2', 'commissions.payment');
            setText('label[for="depositPaid"]', 'commissions.depositPaid');
            setText('label[for="depositAmount"]', 'commissions.depositAmount');
            setPlaceholder('#depositAmount', 'commissions.depositPlaceholder');
            setText('#depositAmount + p', 'commissions.depositHint');
            setText('#commissionForm .form-section:nth-of-type(4) h2', 'commissions.buildTypeTitle');
            setText('#commissionForm .form-section:nth-of-type(4) .form-group > label', 'commissions.buildTypeQuestion');
            setText('#commissionForm .form-section:nth-of-type(5) h2', 'commissions.client');
            setText('label[for="clientName"]', 'commissions.clientName');
            setText('#clientName option[value=""]', 'commissions.selectClient');
            setText('#clientName + button', 'commissions.createClient');
            setText('#newClientForm > p', 'commissions.newClient');
            setText('label[for="newClientPseudo"]', 'commissions.clientPseudo');
            setPlaceholder('#newClientPseudo', 'commissions.clientPseudoPlaceholder');
            setText('label[for="newClientDiscord"]', 'commissions.clientDiscord');
            setPlaceholder('#newClientDiscord', 'commissions.clientDiscordPlaceholder');
            setText('#newClientForm button:not(.secondary)', 'commissions.addClient');
            setText('#newClientForm button.secondary', 'common.cancel');
            setText('label[for="clientFeedback"]', 'commissions.feedbackQuestion');
            setText('label[for="clientFeedbackText"]', 'commissions.feedbackLabel');
            setPlaceholder('#clientFeedbackText', 'commissions.feedbackPlaceholder');
            setText('#commissionForm .form-section:nth-of-type(6) h2', 'commissions.renderSection');
            setText('label[for="render"]', 'commissions.renderLabel');
            setPlaceholder('#render', 'commissions.renderPlaceholder');
            setText('#commissionForm .button-group button[type="button"]', 'commissions.reset');
            setText('#commissionForm button[type="submit"]', editingCommissionId ? 'commissions.saveEdit' : 'commissions.saveNew');

            setText('#agentSectionTitle', 'agents.addTitle');
            setText('label[for="agentPseudo"]', 'agents.pseudo');
            setText('label[for="agentDiscord"]', 'agents.discord');
            setText('#agentForm .form-group > label:not([for]):first-of-type', 'agents.paymentMethods');
            setText('#agentForm button[onclick="addPaymentMethod()"]', 'agents.addPaymentMethod');
            setText('label[for="agentPF"]', 'agents.pf');
            setPlaceholder('#agentPF', 'agents.pfPlaceholder');
            setText('label[for="agentCategory"]', 'agents.category');
            setText('#agentCategory option[value=""]', 'agents.selectCategory');
            setText('#agentCategory option[value="manager"]', 'agents.manager');
            setText('#agentCategory option[value="apprentice"]', 'agents.apprentice');
            setText('#agentCategory option[value="builder"]', 'agents.builder');
            setText('#agentCategory option[value="client"]', 'agents.client');
            setText('label[for="agentCommissionRate"]', 'agents.commissionRate');
            setText('label[for="agentMemberSince"]', 'agents.memberSince');
            setText('label[for="agentIsCurrentTeamMember"]', 'agents.currentTeamMember');
            setText('#agentIsCurrentTeamMember option[value="true"]', 'agents.currentTeamMemberYes');
            setText('#agentIsCurrentTeamMember option[value="false"]', 'agents.currentTeamMemberNo');
            setText('label[for="isCompany"]', 'agents.isCompany');
            setText('label[for="companyIBAN"]', 'agents.iban');
            setText('label[for="companyCountry"]', 'agents.country');
            setText('label[for="companyAddress"]', 'agents.address');
            setText('label[for="companyName"]', 'agents.companyName');
            setText('#agents-tab > h2', 'agents.listTitle');
            setText('#agentForm button[type="button"].secondary', 'agents.reset');
            setText('#agentForm button[type="submit"]', editingAgentId ? 'agents.editAgent' : 'agents.addAgent');
            setText('#engagementSectionTitle', 'agents.engagement.sectionTitle');
            const engagementHintEl = document.getElementById('engagementSectionHint');
            if (engagementHintEl) {
                engagementHintEl.textContent = t('agents.engagement.rulesHint', { days: 60 });
            }
            setText('#engagementAgentLabel', 'agents.engagement.agentLabel');
            setText('#engagementTypeLabel', 'agents.engagement.typeLabel');
            setText('#engagementNoteLabel', 'agents.engagement.noteLabel');
            setPlaceholder('#engagementEventNote', 'agents.engagement.notePlaceholder');
            setText('#engagementDateLabel', 'agents.engagement.dateLabel');
            setText('#engagementRefLabel', 'agents.engagement.refLabel');
            setPlaceholder('#engagementExternalRef', 'agents.engagement.refPlaceholder');
            setText('#engagementSubmitBtn', 'agents.engagement.submit');
            syncEngagementTypeOptions();

            setText('#analyst-tab > h2', 'analyst.title');
            setText('#analyst-tab > p', 'analyst.subtitle');
            setText('#analyst-tab .analyst-section:nth-of-type(1) h3', 'analyst.expenses');
            setText('label[for="expenseLabel"]', 'analyst.expenseLabel');
            setPlaceholder('#expenseLabel', 'analyst.expenseLabelPlaceholder');
            setText('label[for="expenseAmount"]', 'analyst.expenseAmount');
            setPlaceholder('#expenseAmount', 'analyst.expenseAmountPlaceholder');
            setText('label[for="expenseCurrency"]', 'analyst.expenseCurrency');
            setText('label[for="expenseDate"]', 'analyst.expenseDate');
            setText('#expenseControls button', 'analyst.expenseAdd');
            setText('#analyst-tab .analyst-section:nth-of-type(2) h3', 'analyst.allTransactions');
            setText('#analyst-tab .analyst-section:nth-of-type(2) p', 'analyst.allTransactionsHint');
            setText('#analyst-tab .analyst-section:nth-of-type(2) label[for="transactionFilter"]', 'analyst.filter');
            setText('#transactionFilter option[value="all"]', 'analyst.filterAll');
            setText('#transactionFilter option[value="commission"]', 'analyst.filterCommission');
            setText('#transactionFilter option[value="expense"]', 'analyst.filterExpense');
            setText('#transactionFilter option[value="builder"]', 'analyst.filterBuilder');
            setText('#transactionFilter option[value="manager"]', 'analyst.filterManager');
            setText('#transactionFilter option[value="client"]', 'analyst.filterClient');
            setText('#transactionFilterClient option[value=""]', 'analyst.filterClientPlaceholder');
            setText('#analyst-tab .analyst-section:nth-of-type(3) h3', 'analyst.monthlyRevenue');
            setText('#analyst-tab .analyst-section:nth-of-type(4) h3', 'analyst.revenueByAgent');
            setText('#analyst-tab .analyst-section:nth-of-type(5) h3', 'analyst.detailByAgent');

            setText('#userSectionTitle', editingUserId ? 'users.editTitle' : 'users.createTitle');
            setText('label[for="userName"]', 'users.name');
            setText('label[for="userEmail"]', 'users.email');
            setText('label[for="userPassword"]', 'users.password');
            setText('#userPasswordHelp', editingUserId ? 'users.passwordHelpEdit' : 'users.passwordHelpCreate');
            setText('label[for="userRole"]', 'users.role');
            setText('#userRole option[value="guest"]', 'roles.guest');
            setText('#userRole option[value="builder"]', 'roles.builder');
            setText('#userRole option[value="manager"]', 'roles.manager');
            setText('#userRole option[value="admin"]', 'roles.admin');
            setText('#userRole option[value="superadmin"]', 'roles.superadmin');
            setText('label[for="userIsActive"]', 'users.status');
            setText('#userIsActive option[value="true"]', 'users.statusActive');
            setText('#userIsActive option[value="false"]', 'users.statusInactive');
            setText('#userForm .form-group:nth-of-type(4) > label', 'users.assignedAgents');
            setText('#userForm .form-group:nth-of-type(4) > p', 'users.assignedAgentsHint');
            setText('#users-tab > h2', 'users.listTitle');
            setText('#userForm button[type="button"].secondary', 'users.reset');
            setText('#userForm button[type="submit"]', editingUserId ? 'users.update' : 'users.create');

            setText('#todoSectionTitle', editingTodoId ? 'todos.editTitle' : 'todos.createTitle');
            setText('label[for="todoTitle"]', 'todos.title');
            setPlaceholder('#todoTitle', 'todos.titlePlaceholder');
            setText('label[for="todoStatus"]', 'todos.status');
            setText('#todoStatus option[value="todo"]', 'todos.todo');
            setText('#todoStatus option[value="in_progress"]', 'todos.in_progress');
            setText('#todoStatus option[value="done"]', 'todos.done');
            setText('label[for="todoAssignedTo"]', 'todos.assignedTo');
            setPlaceholder('#todoAssignedTo', 'todos.assignedToPlaceholder');
            setText('label[for="todoDeadline"]', 'todos.deadline');
            setText('label[for="todoDeadlineTime"]', 'todos.deadlineTime');
            setText('label[for="todoDescription"]', 'todos.description');
            setPlaceholder('#todoDescription', 'todos.descriptionPlaceholder');
            setText('#todoTeamTitle', 'todos.teamTitle');
            setText('#todoTeamSubtitle', 'todos.teamSubtitle');
            setText('#todoClearFilters', 'todos.clearFilters');
            setText('#todoSearchLabel', 'todos.search');
            setPlaceholder('#todoSearch', 'todos.searchPlaceholder');
            setText('#todoFilterStatusLabel', 'todos.filterStatus');
            setText('#todoFilterStatus option[value=""]', 'todos.filterAllStatuses');
            setText('#todoFilterStatus option[value="todo"]', 'todos.todo');
            setText('#todoFilterStatus option[value="in_progress"]', 'todos.in_progress');
            setText('#todoFilterStatus option[value="done"]', 'todos.done');
            setText('#todoFilterAssigneeLabel', 'todos.filterAssignee');
            setText('#todoFilterAssignee option[value=""]', 'todos.filterAllAssignees');
            setText('#todoSortLabel', 'todos.sortBy');
            setText('#todoSort option[value="deadline"]', 'todos.sortDeadline');
            setText('#todoSort option[value="updated"]', 'todos.sortUpdated');
            setText('#todoSort option[value="created"]', 'todos.sortCreated');
            setText('#todoTotalLabel', 'todos.summaryTotal');
            setText('#todoTodoLabel', 'todos.todo');
            setText('#todoInProgressLabel', 'todos.in_progress');
            setText('#todoDoneLabel', 'todos.done');
            setText('#todoDueTodayLabel', 'todos.summaryDueToday');
            setText('#todoOverdueLabel', 'todos.summaryOverdue');
            setText('#todoArchivedLabel', 'todos.summaryArchived');
            const todoOverdueFilterText = document.querySelector('#todoFilterOverdueLabel span');
            if (todoOverdueFilterText) {
                todoOverdueFilterText.textContent = t('todos.filterOverdue');
            }
            const todoArchivedFilterText = document.querySelector('#todoFilterArchivedLabel span');
            if (todoArchivedFilterText) {
                todoArchivedFilterText.textContent = t('todos.filterArchived');
            }
            setText('#todoForm button[type="button"].secondary', 'todos.reset');
            setText('#todoForm button[type="submit"]', editingTodoId ? 'todos.update' : 'todos.add');

            setText('#accountSectionTitle', 'account.title');
            setText('#accountSectionSubtitle', 'account.subtitle');
            setText('#accountEmptyState', 'account.empty');
            setText('label[for="accountPseudo"]', 'account.pseudo');
            setText('label[for="accountEmail"]', 'account.email');
            setText('label[for="accountDiscord"]', 'account.discord');
            setText('label[for="accountPF"]', 'account.portfolio');
            setText('#accountPaymentMethodsLabel', 'account.paymentMethods');
            setText('#accountAddPaymentMethodButton', 'account.addPaymentMethod');
            setText('#accountSaveButton', 'account.save');
            setText('#accountPasswordTitle', 'account.passwordTitle');
            setText('label[for="accountCurrentPassword"]', 'account.currentPassword');
            setText('label[for="accountNewPassword"]', 'account.newPassword');
            setText('#accountPasswordButton', 'account.updatePassword');

            setText('#data-tab > h2', 'data.title');
            setText('#data-tab .form-section:nth-of-type(1) h2', 'data.storageTitle');
            setText('#data-tab .alert strong', 'data.storageStrong');
            setText('#data-tab .alert p[style*="margin-top: 10px;"]', 'data.storageMeaning');
            const storageItems = document.querySelectorAll('#data-tab .alert ul li');
            if (storageItems[0]) storageItems[0].textContent = t('data.storage1');
            if (storageItems[1]) storageItems[1].textContent = t('data.storage2');
            if (storageItems[2]) storageItems[2].textContent = t('data.storage3');
            if (storageItems[3]) storageItems[3].textContent = t('data.storage4');
            const storageWarn = document.querySelector('#data-tab .alert p:last-of-type');
            if (storageWarn) storageWarn.textContent = t('data.storageWarn');
            setText('#data-tab .form-section:nth-of-type(1) .form-group > label', 'data.stats');
            const statsLabels = document.querySelectorAll('#dataStats p strong');
            if (statsLabels[0]) statsLabels[0].textContent = t('data.statsAgents');
            if (statsLabels[1]) statsLabels[1].textContent = t('data.statsCommissions');
            if (statsLabels[2]) statsLabels[2].textContent = t('data.statsTodos');
            if (statsLabels[3]) statsLabels[3].textContent = t('data.statsStorage');
            setText('#data-tab .form-section:nth-of-type(2) h2', 'data.exportTitle');
            setText('#data-tab .form-section:nth-of-type(2) p', 'data.exportHint');
            const exportButtons = document.querySelectorAll('#data-tab .form-section:nth-of-type(2) .button-group button');
            if (exportButtons[0]) exportButtons[0].textContent = t('data.exportAll');
            if (exportButtons[1]) exportButtons[1].textContent = t('data.exportAgents');
            if (exportButtons[2]) exportButtons[2].textContent = t('data.exportCommissions');
            setText('#dataImportSection h2', 'data.importTitle');
            setText('#dataImportSection p', 'data.importHint');
            setText('label[for="importFile"]', 'data.importFile');
            setText('#importDataButton', 'data.importButton');
            setText('#clearDataButton', 'data.clearButton');

            document.querySelectorAll('.yes-no-btn.yes').forEach(btn => btn.textContent = t('common.yes'));
            document.querySelectorAll('.yes-no-btn.no').forEach(btn => btn.textContent = t('common.no'));
        }

        function getCurrentLocale() {
            return currentLanguage === 'de' ? 'de-DE' : currentLanguage === 'en' ? 'en-GB' : 'fr-FR';
        }

        function setCurrentLanguage(language) {
            if (!SUPPORTED_LANGUAGES.includes(language)) {
                return;
            }

            currentLanguage = language;
            window.localStorage.setItem('lusciana-language', currentLanguage);
            applyStaticTranslations();
            updateAuthUI();
            refreshUIAfterLoad();
        }

        function getTodoStatusLabel(status) {
            return t(`todos.${status}`) || status;
        }

        function getCurrentRole() {
            return currentUser && currentUser.role ? currentUser.role : null;
        }

        function roleAtLeast(minimumRole) {
            const role = getCurrentRole();
            return role !== null && ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimumRole);
        }

        function canReadData() {
            return roleAtLeast('guest');
        }

        function canManageOperationalData() {
            return roleAtLeast('manager');
        }

        function canManageUsers() {
            return roleAtLeast('admin');
        }

        function canManageTodos() {
            return roleAtLeast('builder');
        }

        function canManageOwnAccount() {
            if (!currentUser) {
                return false;
            }

            if (currentUser.agentId) {
                return true;
            }

            const assignedAgentIds = currentUser.assignedAgentIds || [];
            return roleAtLeast('builder') && assignedAgentIds.length === 1;
        }

        function canManageDangerousData() {
            return roleAtLeast('admin');
        }

        function canEditUi() {
            return canManageOperationalData();
        }

        function requirePermission(checker, message) {
            if (checker()) {
                return true;
            }

            alert(message);
            return false;
        }

        function setAuthStatus(message, isError = false) {
            const el = document.getElementById('authStatusMessage');
            if (!el) return;
            el.textContent = message;
            el.style.color = isError ? '#b91c1c' : '#64748b';
        }

        function updateAuthUI() {
            const loginForm = document.getElementById('loginForm');
            const sessionInfo = document.getElementById('sessionInfo');
            const sessionUserLabel = document.getElementById('sessionUserLabel');
            const headerSubtitle = document.getElementById('headerSubtitle');

            if (!loginForm || !sessionInfo || !sessionUserLabel || !headerSubtitle) {
                applyRolePermissions();
                return;
            }

            if (accessToken && currentUser) {
                loginForm.style.display = 'none';
                sessionInfo.style.display = 'flex';
                sessionUserLabel.textContent = `${currentUser.name || currentUser.email} (${getRoleLabel(currentUser.role)})`;
                headerSubtitle.textContent = t('header.subtitleLoggedIn');
                setAuthStatus(t('header.connectedTo', { api: API_BASE_URL }), false);
            } else {
                loginForm.style.display = 'flex';
                sessionInfo.style.display = 'none';
                sessionUserLabel.textContent = '';
                headerSubtitle.textContent = t('header.subtitleLoggedOut');
                setAuthStatus(t('header.noSession'), false);
            }

            applyRolePermissions();
        }

        function applyRolePermissions() {
            const tabAgentsBtn = document.getElementById('tabAgentsBtn');
            const tabUsersBtn = document.getElementById('tabUsersBtn');
            const tabTodosBtn = document.getElementById('tabTodosBtn');
            const tabAccountBtn = document.getElementById('tabAccountBtn');
            const newCommissionButton = document.getElementById('newCommissionButton');
            const commissionFormView = document.getElementById('commissionFormView');
            const agentFormSection = document.getElementById('agentFormSection');
            const agentSectionTitle = document.getElementById('agentSectionTitle');
            const userFormSection = document.getElementById('userFormSection');
            const userRole = document.getElementById('userRole');
            const todoFormSection = document.getElementById('todoFormSection');
            const todoBoard = document.querySelector('#todos-tab .todo-board');
            const expenseControls = document.getElementById('expenseControls');
            const dataImportSection = document.getElementById('dataImportSection');
            const isAuthenticated = Boolean(accessToken && currentUser);
            const isManagerLike = canManageOperationalData();
            const isAdminLike = canManageUsers();
            const isDangerousAdminLike = canManageDangerousData();
            const canWriteTodos = canManageTodos();

            if (tabAgentsBtn) {
                tabAgentsBtn.textContent = isManagerLike ? t('tabs.agentsManage') : t('tabs.agentsList');
            }

            if (tabUsersBtn) {
                tabUsersBtn.style.display = isAuthenticated && isAdminLike ? '' : 'none';
            }

            if (tabTodosBtn) {
                tabTodosBtn.style.display = isAuthenticated ? '' : 'none';
            }

            if (tabAccountBtn) {
                tabAccountBtn.style.display = isAuthenticated && canManageOwnAccount() ? '' : 'none';
            }

            if (newCommissionButton) {
                newCommissionButton.style.display = isManagerLike ? '' : 'none';
            }

            if (commissionFormView && !isManagerLike) {
                commissionFormView.style.display = 'none';
            }

            if (agentFormSection) {
                agentFormSection.style.display = isManagerLike ? '' : 'none';
            }

            const agentEngagementSection = document.getElementById('agentEngagementSection');
            if (agentEngagementSection) {
                agentEngagementSection.style.display = isManagerLike ? '' : 'none';
            }

            if (agentSectionTitle) {
                agentSectionTitle.textContent = isManagerLike ? t('agents.addTitle') : t('agents.listTitle');
            }

            if (userFormSection) {
                userFormSection.style.display = isAuthenticated && isAdminLike ? '' : 'none';
            }

            if (todoFormSection) {
                todoFormSection.style.display = isAuthenticated && canWriteTodos ? '' : 'none';
            }

            if (todoBoard) {
                todoBoard.classList.toggle('readonly-layout', !(isAuthenticated && canWriteTodos));
            }

            if (userRole) {
                const superadminOption = userRole.querySelector('option[value="superadmin"]');
                if (superadminOption) {
                    superadminOption.style.display = getCurrentRole() === 'superadmin' ? '' : 'none';
                    if (getCurrentRole() !== 'superadmin' && userRole.value === 'superadmin') {
                        userRole.value = 'admin';
                    }
                }
            }

            if (expenseControls) {
                expenseControls.style.display = isManagerLike ? 'flex' : 'none';
            }

            if (dataImportSection) {
                dataImportSection.style.display = isAuthenticated && isDangerousAdminLike ? '' : 'none';
            }
        }

        function setAuthenticatedState(authenticated) {
            const tabs = document.querySelector('.tabs');
            if (tabs) tabs.style.display = authenticated ? '' : 'none';

            document.querySelectorAll('.tab-content').forEach(content => {
                content.style.display = authenticated ? '' : 'none';
            });

            if (!authenticated) {
                const listView = document.getElementById('commissionListView');
                const formView = document.getElementById('commissionFormView');
                if (listView) listView.style.display = 'block';
                if (formView) formView.style.display = 'none';
            }

            updateAuthUI();
        }

        function clearSessionData() {
            accessToken = null;
            refreshToken = null;
            currentUser = null;
            agentsCache = [];
            commissionsCache = [];
            expensesCache = [];
            usersCache = [];
            todosCache = [];
            accountProfile = null;
            clearSessionIdleTimer();
            clearAuthSessionStorage();
            clearSessionRemoteDataCache();
        }

        async function apiRequest(path, options = {}) {
            const {
                method = 'GET',
                body = null,
                auth = true,
                retryOnAuthFailure = true
            } = options;

            if (auth && accessToken && isSessionExpiredByPolicy()) {
                await expireSession('expired');
                throw new Error(t('header.noSession'));
            }

            const headers = {};
            if (body !== null) {
                headers['Content-Type'] = 'application/json';
            }
            if (auth && accessToken) {
                headers['Authorization'] = `Bearer ${accessToken}`;
            }

            const response = await fetch(`${API_BASE_URL}${path}`, {
                method,
                headers,
                body: body === null ? undefined : JSON.stringify(body)
            });

            const contentType = response.headers.get('content-type') || '';
            const payload = contentType.includes('application/json')
                ? await response.json()
                : await response.text();

            if (response.status === 401 && auth && retryOnAuthFailure && refreshToken) {
                try {
                    await refreshSession();
                    return apiRequest(path, { method, body, auth, retryOnAuthFailure: false });
                } catch (error) {
                    clearSessionData();
                    setAuthenticatedState(false);
                    throw error;
                }
            }

            if (!response.ok) {
                const message = payload && typeof payload === 'object' && payload.message
                    ? translateServerMessage(payload.message)
                    : `API error (${response.status})`;
                const error = new Error(message);
                error.status = response.status;
                throw error;
            }

            if (auth && accessToken) {
                touchSessionActivity();
            }

            return payload;
        }

        function formatFetchError(error) {
            const msg = error && typeof error.message === 'string' ? error.message : String(error);
            if (/Failed to fetch|NetworkError|Load failed|NETWORK_FAILED/i.test(msg)) {
                return `${msg}\n\n${t('alerts.apiNetworkHint', { api: API_BASE_URL })}`;
            }
            return msg;
        }

        async function copyTextToClipboard(text) {
            if (!text) {
                return false;
            }

            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(text);
                return true;
            }

            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();

            try {
                return document.execCommand('copy');
            } finally {
                document.body.removeChild(textarea);
            }
        }

        async function refreshSession() {
            if (!refreshToken) {
                throw new Error(t('header.noSession'));
            }

            const payload = await apiRequest('/auth/refresh', {
                method: 'POST',
                body: { refreshToken },
                auth: false,
                retryOnAuthFailure: false
            });

            accessToken = payload.accessToken;
            refreshToken = payload.refreshToken;
            currentUser = payload.user;
            updateAuthUI();
            touchSessionActivity();
            persistAuthSession();
        }

        async function login(email, password) {
            const payload = await apiRequest('/auth/login', {
                method: 'POST',
                body: { email, password },
                auth: false,
                retryOnAuthFailure: false
            });

            accessToken = payload.accessToken;
            refreshToken = payload.refreshToken;
            currentUser = payload.user;
            markSessionStarted();
            setAuthenticatedState(true);
            await loadRemoteData();
            persistAuthSession();
        }

        async function logout() {
            try {
                if (refreshToken) {
                    await apiRequest('/auth/logout', {
                        method: 'POST',
                        body: { refreshToken },
                        auth: false,
                        retryOnAuthFailure: false
                    });
                }
            } catch (error) {
                console.warn('Deconnexion distante impossible.', error);
            }

            clearSessionData();
            setAuthenticatedState(false);
            if (typeof history.replaceState === 'function') {
                history.replaceState(null, '', window.location.pathname + window.location.search);
            }
            refreshUIAfterLoad();
        }

        function refreshUIAfterLoad() {
            loadAgentsIntoSelects();
            loadAgentsIntoSelector();
            loadAgentsIntoUserSelector();
            updateDataStats();
            displayCommissions();
            displayAgents();
            displayUsers();
            displayTodos();
            populateAccountForm();
            if (typeof refreshAnalyst === 'function') refreshAnalyst();
        }

        async function loadRemoteData() {
            const cacheKey = remoteDataCacheUserKey();
            const cachedPayload = readSessionRemoteDataCache(cacheKey);
            if (cachedPayload) {
                applyRemotePayload(cachedPayload);
                refreshUIAfterLoad();
            }

            const expensesPromise = apiRequest('/expenses').catch(error => {
                console.error('[Lusciana] Echec chargement depenses', error);
                return { items: [] };
            });

            const usersPromise = canManageUsers()
                ? apiRequest('/users').catch(error => {
                    console.error('[Lusciana] Echec chargement utilisateurs', error);
                    return { items: [] };
                })
                : Promise.resolve({ items: [] });

            const accountPromise = canManageOwnAccount()
                ? apiRequest('/account').catch(error => {
                    console.error('[Lusciana] Echec chargement compte', error);
                    return null;
                })
                : Promise.resolve(null);

            const safeList = async (path, label) => {
                try {
                    return await apiRequest(path);
                } catch (error) {
                    console.error(`[Lusciana] Echec chargement ${label}`, path, error);
                    return { items: [] };
                }
            };

            const [agentsResponse, commissionsResponse, expensesResponse, usersResponse, todosResponse, accountResponse] = await Promise.all([
                safeList('/agents', 'agents'),
                safeList('/commissions', 'commissions'),
                expensesPromise,
                usersPromise,
                safeList('/todos', 'todos'),
                accountPromise
            ]);

            agentsCache = Array.isArray(agentsResponse.items) ? agentsResponse.items : [];
            commissionsCache = Array.isArray(commissionsResponse.items) ? commissionsResponse.items : [];
            expensesCache = Array.isArray(expensesResponse.items) ? expensesResponse.items : [];
            usersCache = Array.isArray(usersResponse.items) ? usersResponse.items : [];
            todosCache = Array.isArray(todosResponse.items) ? todosResponse.items : [];
            accountProfile = accountResponse;
            writeSessionRemoteDataCache(cacheKey, {
                agents: agentsCache,
                commissions: commissionsCache,
                expenses: expensesCache,
                users: usersCache,
                todos: todosCache,
                accountProfile
            });
            refreshUIAfterLoad();
            applyTabFromHash();
        }

        async function refreshUsersData() {
            if (!canManageUsers()) {
                usersCache = [];
                return;
            }

            const response = await apiRequest('/users').catch(error => {
                if (error.status === 403) {
                    return { items: [] };
                }
                throw error;
            });

            usersCache = Array.isArray(response.items) ? response.items : [];
        }

        const PRIMARY_TAB_NAMES = ['list', 'agents', 'users', 'todos', 'account', 'analyst', 'data'];

        function syncPrimaryTabHash(tabName) {
            if (!accessToken || typeof history.replaceState !== 'function') {
                return;
            }
            const next = '#' + tabName;
            if (location.hash !== next) {
                history.replaceState(null, '', next);
            }
        }

        function applyTabFromHash() {
            if (!accessToken) {
                return;
            }
            const raw = (location.hash || '#list').replace(/^#/, '').trim();
            const tabName = PRIMARY_TAB_NAMES.includes(raw) ? raw : 'list';
            const tabBtnIds = {
                list: 'tabListBtn',
                agents: 'tabAgentsBtn',
                users: 'tabUsersBtn',
                todos: 'tabTodosBtn',
                account: 'tabAccountBtn',
                analyst: 'tabAnalystBtn',
                data: 'tabDataBtn'
            };
            const btn = document.getElementById(tabBtnIds[tabName]);
            void showTab(tabName, btn, { syncHash: false });
        }

        // Gestion des onglets
        async function showTab(tabName, element, options) {
            const opts = options || {};
            if (!accessToken) {
                return;
            }

            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            if (element) {
                element.classList.add('active');
            } else {
                const tabIds = {
                    list: 'tabListBtn',
                    agents: 'tabAgentsBtn',
                    users: 'tabUsersBtn',
                    todos: 'tabTodosBtn',
                    account: 'tabAccountBtn',
                    analyst: 'tabAnalystBtn',
                    data: 'tabDataBtn'
                };
                const fallbackTab = document.getElementById(tabIds[tabName]);
                if (fallbackTab) {
                    fallbackTab.classList.add('active');
                }
            }
            
            document.getElementById(tabName + '-tab').classList.add('active');

            if (opts.syncHash !== false) {
                syncPrimaryTabHash(tabName);
            }
            
            if (tabName === 'list') {
                displayCommissions();
            } else if (tabName === 'agents') {
                displayAgents();
            } else if (tabName === 'users') {
                try {
                    await refreshUsersData();
                } catch (error) {
                    console.error('Impossible de rafraichir la liste des utilisateurs.', error);
                }
                displayUsers();
            } else if (tabName === 'todos') {
                displayTodos();
            } else if (tabName === 'account') {
                populateAccountForm();
            } else if (tabName === 'analyst') {
                refreshAnalyst();
            } else if (tabName === 'data') {
                updateDataStats();
            }
        }
        
        // Lecture / écriture (cache en mémoire + API)
        function getAgents() {
            return agentsCache;
        }
        
        function saveAgents(agents) {
            agentsCache = agents;
        }
        
        function getCommissions() {
            return commissionsCache;
        }
        
        function saveCommissions(commissions) {
            commissionsCache = commissions;
        }
        
        function getExpenses() {
            return expensesCache;
        }
        
        function saveExpenses(expenses) {
            expensesCache = expenses;
        }

        function getUsers() {
            return usersCache;
        }

        function saveUsers(users) {
            usersCache = users;
        }

        function getTodos() {
            return todosCache;
        }

        function saveTodos(todos) {
            todosCache = todos;
        }
        
        async function addExpense() {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionExpenses'))) {
                return;
            }

            const label = document.getElementById('expenseLabel').value.trim();
            const amount = parseFloat(document.getElementById('expenseAmount').value);
            const currency = document.getElementById('expenseCurrency').value;
            const date = document.getElementById('expenseDate').value || new Date().toISOString().slice(0, 10);
            if (!label) {
                alert(t('alerts.expenseLabelRequired'));
                return;
            }
            if (isNaN(amount) || amount <= 0) {
                alert(t('alerts.expenseAmountRequired'));
                return;
            }

            try {
                const response = await apiRequest('/expenses', {
                    method: 'POST',
                    body: { label, amount, currency, date }
                });
                saveExpenses([...getExpenses(), response.item]);
                document.getElementById('expenseLabel').value = '';
                document.getElementById('expenseAmount').value = '';
                document.getElementById('expenseDate').value = '';
                refreshAnalyst();
            } catch (error) {
                alert(t('alerts.expenseCreateFailed', { error: error.message }));
            }
        }
        
        async function deleteExpense(id) {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionExpenses'))) {
                return;
            }

            try {
                await apiRequest(`/expenses/${id}`, { method: 'DELETE' });
                saveExpenses(getExpenses().filter(e => e.id !== id));
                refreshAnalyst();
            } catch (error) {
                alert(t('alerts.expenseDeleteFailed', { error: error.message }));
            }
        }
        
        // Gestion des moyens de paiement
        let paymentMethodCounter = 0;
        
        function addPaymentMethod(paymentData = null) {
            if (!paymentData && !requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            const list = document.getElementById('paymentMethodsList');
            const id = paymentData ? paymentData.id : `payment_${Date.now()}_${paymentMethodCounter++}`;
            const div = document.createElement('div');
            div.className = 'payment-method-item';
            div.id = `paymentMethod_${id}`;
            
            const paymentType = paymentData ? paymentData.type : '';
            const paymentDetails = paymentData ? paymentData.details : '';
            
            div.innerHTML = `
                <div class="form-row">
                    <div class="form-group">
                        <label>Type de paiement :</label>
                        <select class="payment-type-select" onchange="updatePaymentFields('${id}', this.value)" required>
                            <option value="">${t('agents.paymentTypeSelect')}</option>
                            <option value="virement" ${paymentType === 'virement' ? 'selected' : ''}>Virement bancaire</option>
                            <option value="paypal" ${paymentType === 'paypal' ? 'selected' : ''}>PayPal</option>
                            <option value="autre" ${paymentType === 'autre' ? 'selected' : ''}>Autre</option>
                        </select>
                    </div>
                    <div class="form-group payment-details-field">
                        <label class="payment-details-label">${t('agents.paymentDetails')}</label>
                        <input type="text" class="payment-details-input" value="${paymentDetails || ''}" placeholder="${t('agents.paymentDetailsPlaceholder')}">
                    </div>
                </div>
                <button type="button" class="remove-payment danger" onclick="removePaymentMethod('${id}')">${t('agents.removePayment')}</button>
            `;
            
            list.appendChild(div);
            
            // Si un type est déjà sélectionné, mettre à jour les champs
            if (paymentType) {
                updatePaymentFields(id, paymentType);
            }
        }
        
        function updatePaymentFields(paymentId, paymentType) {
            const item = document.getElementById(`paymentMethod_${paymentId}`);
            if (!item) return;
            
            const label = item.querySelector('.payment-details-label');
            const input = item.querySelector('.payment-details-input');
            
            switch(paymentType) {
                case 'virement':
                    label.textContent = t('agents.paymentBankType');
                    input.placeholder = t('agents.paymentBankPlaceholder');
                    input.type = 'text';
                    break;
                case 'paypal':
                    label.textContent = t('agents.paymentPaypal');
                    input.placeholder = t('agents.paymentPaypalPlaceholder');
                    input.type = 'email';
                    break;
                case 'autre':
                    label.textContent = t('agents.paymentDetails');
                    input.placeholder = t('agents.paymentOtherPlaceholder');
                    input.type = 'text';
                    break;
                default:
                    label.textContent = t('agents.paymentDetails');
                    input.placeholder = t('agents.paymentDetailsPlaceholder');
                    input.type = 'text';
            }
        }
        
        function removePaymentMethod(paymentId) {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            const item = document.getElementById(`paymentMethod_${paymentId}`);
            if (item) {
                item.remove();
            }
        }
        
        function getPaymentMethods() {
            const items = document.querySelectorAll('.payment-method-item');
            const methods = [];
            
            items.forEach(item => {
                const typeSelect = item.querySelector('.payment-type-select');
                const detailsInput = item.querySelector('.payment-details-input');
                
                if (typeSelect && typeSelect.value && detailsInput && detailsInput.value) {
                    methods.push({
                        id: item.id.replace('paymentMethod_', ''),
                        type: typeSelect.value,
                        details: detailsInput.value
                    });
                }
            });
            
            return methods;
        }

        let accountPaymentMethodCounter = 0;

        function addAccountPaymentMethod(paymentData = null) {
            const list = document.getElementById('accountPaymentMethodsList');
            if (!list) return;

            const id = paymentData ? paymentData.id : `account_payment_${Date.now()}_${accountPaymentMethodCounter++}`;
            const div = document.createElement('div');
            div.className = 'payment-method-item';
            div.id = `accountPaymentMethod_${id}`;

            const paymentType = paymentData ? paymentData.type : '';
            const paymentDetails = paymentData ? paymentData.details : '';

            div.innerHTML = `
                <div class="form-row">
                    <div class="form-group">
                        <label>Type de paiement :</label>
                        <select class="account-payment-type-select" onchange="updateAccountPaymentFields('${id}', this.value)" required>
                            <option value="">${t('agents.paymentTypeSelect')}</option>
                            <option value="virement" ${paymentType === 'virement' ? 'selected' : ''}>Virement bancaire</option>
                            <option value="paypal" ${paymentType === 'paypal' ? 'selected' : ''}>PayPal</option>
                            <option value="autre" ${paymentType === 'autre' ? 'selected' : ''}>Autre</option>
                        </select>
                    </div>
                    <div class="form-group account-payment-details-field">
                        <label class="account-payment-details-label">${t('agents.paymentDetails')}</label>
                        <input type="text" class="account-payment-details-input" value="${paymentDetails || ''}" placeholder="${t('agents.paymentDetailsPlaceholder')}">
                    </div>
                </div>
                <button type="button" class="remove-payment danger" onclick="removeAccountPaymentMethod('${id}')">${t('agents.removePayment')}</button>
            `;

            list.appendChild(div);

            if (paymentType) {
                updateAccountPaymentFields(id, paymentType);
            }
        }

        function updateAccountPaymentFields(paymentId, paymentType) {
            const item = document.getElementById(`accountPaymentMethod_${paymentId}`);
            if (!item) return;

            const label = item.querySelector('.account-payment-details-label');
            const input = item.querySelector('.account-payment-details-input');

            switch (paymentType) {
                case 'virement':
                    label.textContent = t('agents.paymentBankType');
                    input.placeholder = t('agents.paymentBankPlaceholder');
                    input.type = 'text';
                    break;
                case 'paypal':
                    label.textContent = t('agents.paymentPaypal');
                    input.placeholder = t('agents.paymentPaypalPlaceholder');
                    input.type = 'email';
                    break;
                case 'autre':
                    label.textContent = t('agents.paymentDetails');
                    input.placeholder = t('agents.paymentOtherPlaceholder');
                    input.type = 'text';
                    break;
                default:
                    label.textContent = t('agents.paymentDetails');
                    input.placeholder = t('agents.paymentDetailsPlaceholder');
                    input.type = 'text';
            }
        }

        function removeAccountPaymentMethod(paymentId) {
            const item = document.getElementById(`accountPaymentMethod_${paymentId}`);
            if (item) {
                item.remove();
            }
        }

        function getAccountPaymentMethods() {
            return Array.from(document.querySelectorAll('#accountPaymentMethodsList .payment-method-item'))
                .map(item => {
                    const typeSelect = item.querySelector('.account-payment-type-select');
                    const detailsInput = item.querySelector('.account-payment-details-input');
                    if (!typeSelect || !typeSelect.value || !detailsInput || !detailsInput.value.trim()) {
                        return null;
                    }

                    return {
                        id: item.id.replace('accountPaymentMethod_', ''),
                        type: typeSelect.value,
                        details: detailsInput.value.trim()
                    };
                })
                .filter(Boolean);
        }

        function populateAccountForm() {
            const form = document.getElementById('accountForm');
            const emptyState = document.getElementById('accountEmptyState');
            if (!form || !emptyState) return;

            if (!accountProfile || !accountProfile.agent) {
                form.classList.add('hidden');
                document.getElementById('accountPasswordForm')?.classList.add('hidden');
                emptyState.classList.remove('hidden');
                return;
            }

            const agent = accountProfile.agent;
            form.classList.remove('hidden');
            document.getElementById('accountPasswordForm')?.classList.remove('hidden');
            emptyState.classList.add('hidden');

            document.getElementById('accountPseudo').value = agent.pseudo || '';
            document.getElementById('accountEmail').value = accountProfile.loginEmail || currentUser?.email || '';
            document.getElementById('accountDiscord').value = agent.discord || '';
            document.getElementById('accountPF').value = agent.pf || '';

            const paymentList = document.getElementById('accountPaymentMethodsList');
            paymentList.innerHTML = '';
            if (Array.isArray(agent.paymentMethods) && agent.paymentMethods.length > 0) {
                agent.paymentMethods.forEach(paymentMethod => addAccountPaymentMethod(paymentMethod));
            }
        }
        
        function toggleNewClientForm() {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            const form = document.getElementById('newClientForm');
            form.classList.toggle('hidden');
            if (!form.classList.contains('hidden')) {
                document.getElementById('newClientPseudo').value = '';
                document.getElementById('newClientDiscord').value = '';
                document.getElementById('newClientPseudo').focus();
            }
        }
        
        async function addClientFromCommission() {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            const pseudo = document.getElementById('newClientPseudo').value.trim();
            const discord = document.getElementById('newClientDiscord').value.trim();
            if (!pseudo) {
                alert(t('alerts.clientPseudoRequired'));
                return;
            }
            if (!discord) {
                alert(t('alerts.clientDiscordRequired'));
                return;
            }
            const agents = getAgents();
            if (agents.some(a => a.pseudo.toLowerCase() === pseudo.toLowerCase())) {
                alert(t('alerts.clientExists'));
                return;
            }
            const newClient = {
                id: Date.now().toString(),
                pseudo: pseudo,
                discord: discord,
                paymentMethods: [],
                pf: '',
                category: 'client',
                commissionRate: 0,
                memberSince: '',
                isCompany: false,
                iban: '',
                country: '',
                address: '',
                companyName: ''
            };

            try {
                const response = await apiRequest('/agents', {
                    method: 'POST',
                    body: newClient
                });
                saveAgents([...agents, response.item]);
                loadAgentsIntoSelects();
                document.getElementById('clientName').value = pseudo;
                toggleNewClientForm();
            } catch (error) {
                alert(error.message);
            }
        }
        
        // Gestion des Agents (liste clients pour le formulaire commission)
        function loadAgentsIntoSelects() {
            const agents = getAgents();
            const clientNameSelect = document.getElementById('clientName');
            if (!clientNameSelect) return;
            clientNameSelect.innerHTML = `<option value="">${t('commissions.selectClient')}</option>`;
            agents.forEach(agent => {
                if (agent.category === 'client') {
                    const option = new Option(agent.pseudo, agent.pseudo);
                    clientNameSelect.add(option);
                }
            });
        }
        
        function loadAgentsIntoSelector() {
            const agents = getAgents().filter(a => a.category !== 'client');
            const selector = document.getElementById('agentSelector');
            if (!selector) return;
            selector.innerHTML = '';
            
            agents.forEach(agent => {
                const div = document.createElement('div');
                div.className = 'agent-checkbox';
                div.innerHTML = `
                    <input type="checkbox" id="agent_${agent.pseudo}" value="${agent.pseudo}" onchange="updatePriceDistribution()">
                    <label for="agent_${agent.pseudo}">${agent.pseudo}</label>
                `;
                selector.appendChild(div);
            });
        }

        function getAssignableAgents() {
            return getAgents().filter(agent => agent.category !== 'client');
        }

        function buildLoginEmailFromPseudo(pseudo) {
            const localPart = String(pseudo || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9._-]+/g, '.')
                .replace(/^\.+|\.+$/g, '');

            return localPart ? `${localPart}@lusciana.fr` : '';
        }

        function loadAgentsIntoUserSelector(selectedIds = []) {
            const selector = document.getElementById('userAgentSelector');
            if (!selector) return;

            const normalizedSelectedIds = selectedIds.map(String);
            const agents = getAssignableAgents();
            selector.innerHTML = '';

            if (agents.length === 0) {
                selector.innerHTML = `<p style="color: #64748b; padding: 12px 0;">${t('users.noAssignedAgents')}</p>`;
                return;
            }

            agents.forEach(agent => {
                const div = document.createElement('div');
                div.className = 'agent-checkbox';
                div.innerHTML = `
                    <input type="checkbox" id="userAgent_${agent.id}" value="${agent.id}" ${normalizedSelectedIds.includes(String(agent.id)) ? 'checked' : ''} onchange="syncManagedUserAccountFields()">
                    <label for="userAgent_${agent.id}">${agent.pseudo}</label>
                `;
                selector.appendChild(div);
            });

            syncManagedUserAccountFields();
        }

        function getSelectedUserAgentIds() {
            return Array.from(document.querySelectorAll('#userAgentSelector input[type="checkbox"]:checked'))
                .map(input => input.value);
        }

        function syncManagedUserAccountFields() {
            const role = document.getElementById('userRole')?.value;
            const isLinkedAgentRole = role === 'builder' || role === 'manager';
            const selectedIds = getSelectedUserAgentIds();
            const selectedAgent = selectedIds.length === 1
                ? getAssignableAgents().find(agent => String(agent.id) === String(selectedIds[0]))
                : null;
            const nameInput = document.getElementById('userName');
            const emailInput = document.getElementById('userEmail');

            if (!nameInput || !emailInput) return;

            if (isLinkedAgentRole && selectedAgent) {
                nameInput.value = selectedAgent.pseudo || '';
                emailInput.value = buildLoginEmailFromPseudo(selectedAgent.pseudo || '');
                emailInput.readOnly = true;
            } else {
                emailInput.readOnly = false;
            }
        }

        let editingUserId = null;

        function resetUserForm() {
            const form = document.getElementById('userForm');
            const passwordInput = document.getElementById('userPassword');
            const passwordHelp = document.getElementById('userPasswordHelp');
            const roleSelect = document.getElementById('userRole');
            const title = document.getElementById('userSectionTitle');
            const submitBtn = document.querySelector('#userForm button[type="submit"]');
            if (!form || !passwordInput || !passwordHelp || !roleSelect || !submitBtn || !title) return;

            form.reset();
            editingUserId = null;
            title.textContent = t('users.createTitle');
            passwordInput.required = true;
            passwordInput.value = '';
            passwordHelp.textContent = t('users.passwordHelpCreate');
            document.getElementById('userIsActive').value = 'true';
            roleSelect.value = getCurrentRole() === 'superadmin' ? 'admin' : 'builder';
            loadAgentsIntoUserSelector();
            applyRolePermissions();
            submitBtn.textContent = t('users.create');
        }

        function getAssignedAgentNames(user) {
            const assignableAgents = getAssignableAgents();
            return (user.assignedAgentIds || [])
                .map(agentId => assignableAgents.find(agent => String(agent.id) === String(agentId)))
                .filter(Boolean)
                .map(agent => agent.pseudo);
        }

        function displayUsers() {
            const list = document.getElementById('userList');
            if (!list) return;

            if (!canManageUsers()) {
                list.innerHTML = `<p style="color: #64748b; padding: 24px;">${t('users.restricted')}</p>`;
                return;
            }

            const users = getUsers();
            if (users.length === 0) {
                list.innerHTML = `<p style="color: #64748b; padding: 24px;">${t('users.noUsers')}</p>`;
                return;
            }

            list.innerHTML = users.map(user => {
                const assignedAgentNames = getAssignedAgentNames(user);
                const assignmentBlock = assignedAgentNames.length > 0
                    ? `<ul class="user-assignment-list">${assignedAgentNames.map(name => `<li>${name}</li>`).join('')}</ul>`
                    : `<p style="font-size: 13px; color: #64748b; margin-top: 10px;">${t('users.noAssignedAgents')}</p>`;
                const loginEventsBlock = renderRecentLoginEvents(user.recentLoginEvents || []);
                const canEditThisUser = !(user.role === 'superadmin' && getCurrentRole() !== 'superadmin');
                const toggleLabel = user.isActive ? t('users.deactivate') : t('users.reactivate');

                return `
                    <div class="user-card">
                        <h3>${user.name || user.email}</h3>
                        <p><strong>${t('users.userEmail')}</strong> ${user.email}</p>
                        <p><strong>${t('users.userRole')}</strong> ${getRoleLabel(user.role)}</p>
                        <p><strong>${t('users.userStatus')}</strong> ${user.isActive ? t('common.statusActive') : t('common.statusInactive')}</p>
                        <p><strong>${t('users.lastLogin')}</strong> ${formatDateTime(user.lastLoginAt)}</p>
                        <div style="margin-top: 14px;">
                            <p style="font-weight: 600; color: #334155;">${t('users.assignedAgentsTitle')}</p>
                            ${assignmentBlock}
                        </div>
                        <div class="user-login-events">
                            <p class="user-login-events-title">${t('users.recentLogins')}</p>
                            ${loginEventsBlock}
                        </div>
                        ${canEditThisUser ? `
                        <div style="margin-top: 15px; display: flex; gap: 10px; flex-wrap: wrap;">
                            <button type="button" onclick="editUser('${user.id}')">${t('users.edit')}</button>
                            <button type="button" class="secondary" onclick="toggleUserActive('${user.id}')">${toggleLabel}</button>
                        </div>
                        ` : ''}
                    </div>
                `;
            }).join('');
        }

        function editUser(userId) {
            if (!requirePermission(canManageUsers, t('alerts.permissionUsers'))) {
                return;
            }

            const user = getUsers().find(item => item.id === userId);
            if (!user) return;

            if (user.role === 'superadmin' && getCurrentRole() !== 'superadmin') {
                alert(t('alerts.permissionUserSuperadmin'));
                return;
            }

            editingUserId = userId;
            document.getElementById('userName').value = user.name || '';
            document.getElementById('userEmail').value = user.email || '';
            document.getElementById('userPassword').value = '';
            document.getElementById('userPassword').required = false;
            document.getElementById('userPasswordHelp').textContent = t('users.passwordHelpEdit');
            document.getElementById('userRole').value = user.role || 'builder';
            document.getElementById('userIsActive').value = user.isActive ? 'true' : 'false';
            document.getElementById('userSectionTitle').textContent = t('users.editTitle');
            loadAgentsIntoUserSelector((user.assignedAgentIds || []).map(String));
            applyRolePermissions();

            const submitBtn = document.querySelector('#userForm button[type="submit"]');
            if (submitBtn) {
                submitBtn.textContent = t('users.update');
            }

            showTab('users');
            document.getElementById('userForm').scrollIntoView({ behavior: 'smooth' });
        }

        async function toggleUserActive(userId) {
            if (!requirePermission(canManageUsers, t('alerts.permissionUsers'))) {
                return;
            }

            const user = getUsers().find(item => item.id === userId);
            if (!user) return;

            if (user.role === 'superadmin' && getCurrentRole() !== 'superadmin') {
                alert(t('alerts.permissionUserSuperadmin'));
                return;
            }

            const nextStatus = !user.isActive;
            const label = nextStatus ? 'réactiver' : 'désactiver';
            if (!confirm(`Voulez-vous vraiment ${label} ${user.email} ?`)) {
                return;
            }

            try {
                const response = await apiRequest(`/users/${userId}`, {
                    method: 'PATCH',
                    body: { isActive: nextStatus }
                });
                saveUsers(getUsers().map(item => item.id === userId ? response.item : item));
                displayUsers();
            } catch (error) {
                alert(t('alerts.userStatusFailed', { error: error.message }));
            }
        }

        function bindElementEvent(id, eventName, handler) {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener(eventName, handler);
            }
        }

        bindElementEvent('userForm', 'submit', async function(e) {
            e.preventDefault();

            if (!requirePermission(canManageUsers, t('alerts.permissionUsers'))) {
                return;
            }

            const role = document.getElementById('userRole').value;
            const password = document.getElementById('userPassword').value;
            if (!editingUserId && !password) {
                alert(t('alerts.userPasswordRequired'));
                return;
            }

            const payload = {
                name: document.getElementById('userName').value.trim(),
                email: document.getElementById('userEmail').value.trim(),
                role,
                isActive: document.getElementById('userIsActive').value === 'true',
                assignedAgentIds: getSelectedUserAgentIds()
            };

            if (!payload.name || !payload.email) {
                alert(t('alerts.userNameEmailRequired'));
                return;
            }

            if (password) {
                payload.password = password;
            }

            try {
                let response;
                if (editingUserId) {
                    response = await apiRequest(`/users/${editingUserId}`, {
                        method: 'PATCH',
                        body: payload
                    });
                    saveUsers(getUsers().map(item => item.id === editingUserId ? response.item : item));
                    alert(t('alerts.userUpdated'));
                } else {
                    response = await apiRequest('/users', {
                        method: 'POST',
                        body: payload
                    });
                    saveUsers([response.item, ...getUsers()]);
                    alert(t('alerts.userCreated'));
                }

                resetUserForm();
                displayUsers();
            } catch (error) {
                alert(t('alerts.userSaveFailed', { error: error.message }));
            }
        });

        let editingTodoId = null;

        function resetTodoForm() {
            const form = document.getElementById('todoForm');
            const title = document.getElementById('todoSectionTitle');
            const submitBtn = document.querySelector('#todoForm button[type="submit"]');
            if (!form || !title || !submitBtn) return;

            form.reset();
            editingTodoId = null;
            title.textContent = t('todos.createTitle');
            document.getElementById('todoStatus').value = 'todo';
            submitBtn.textContent = t('todos.add');
        }

        function resetTodoFilters() {
            const search = document.getElementById('todoSearch');
            const status = document.getElementById('todoFilterStatus');
            const assignee = document.getElementById('todoFilterAssignee');
            const overdue = document.getElementById('todoFilterOverdue');
            const archived = document.getElementById('todoFilterArchived');
            const sort = document.getElementById('todoSort');

            if (search) search.value = '';
            if (status) status.value = '';
            if (assignee) assignee.value = '';
            if (overdue) overdue.checked = false;
            if (archived) archived.checked = false;
            if (sort) sort.value = 'deadline';

            displayTodos();
        }

        function formatTodoDate(dateString) {
            if (!dateString) return t('common.none');
            const date = new Date(`${dateString}T12:00:00`);
            return Number.isNaN(date.getTime()) ? t('common.none') : date.toLocaleDateString(getCurrentLocale());
        }

        function formatTodoDeadline(todo) {
            if (!todo?.deadline) return t('common.none');

            const date = formatTodoDate(todo.deadline);
            return todo.deadlineTime ? `${date} ${todo.deadlineTime}` : date;
        }

        function getTodoDeadlineTimestamp(todo) {
            if (!todo?.deadline) {
                return Number.MAX_SAFE_INTEGER;
            }

            const time = todo.deadlineTime || '23:59';
            const date = new Date(`${todo.deadline}T${time}:00`);
            return Number.isNaN(date.getTime()) ? Number.MAX_SAFE_INTEGER : date.getTime();
        }

        function formatDateTime(value) {
            if (!value) return t('common.never');

            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? t('common.never') : date.toLocaleString(getCurrentLocale());
        }

        function formatLoginEventDetails(event) {
            const ipAddress = event?.ipAddress || t('common.none');
            return `${t('users.ipAddress')}: ${ipAddress}`;
        }

        function renderLoginEventItem(event) {
            return `
                <li class="user-login-event-item">
                    <p class="user-login-event-meta">${escapeHtml(t('users.siteLoginLine', { date: formatDateTime(event.occurredAt) }))}</p>
                    <p class="user-login-event-details">${escapeHtml(formatLoginEventDetails(event))}</p>
                </li>
            `;
        }

        function renderRecentLoginEvents(events = []) {
            if (!Array.isArray(events) || events.length === 0) {
                return `<p class="user-login-empty">${t('users.noLoginHistory')}</p>`;
            }

            const previewEvents = events.slice(0, 3);
            const remainingEvents = events.slice(3);

            return `
                <ul class="user-login-event-list">
                    ${previewEvents.map(renderLoginEventItem).join('')}
                </ul>
                ${remainingEvents.length > 0 ? `
                    <details class="user-login-more">
                        <summary>${t('users.seeMoreLogins')} (${remainingEvents.length})</summary>
                        <ul class="user-login-event-list extra">
                            ${remainingEvents.map(renderLoginEventItem).join('')}
                        </ul>
                    </details>
                ` : ''}
            `;
        }

        function escapeHtml(value) {
            if (value == null) return '';
            const div = document.createElement('div');
            div.textContent = String(value);
            return div.innerHTML;
        }

        function isTodoOverdue(todo) {
            if (!todo || todo.status === 'done' || !todo.deadline) {
                return false;
            }

            return getTodoDeadlineTimestamp(todo) < Date.now();
        }

        function isTodoDueToday(todo) {
            if (!todo || todo.status === 'done' || !todo.deadline) {
                return false;
            }

            const today = new Date();
            const year = today.getFullYear();
            const month = String(today.getMonth() + 1).padStart(2, '0');
            const day = String(today.getDate()).padStart(2, '0');
            return todo.deadline === `${year}-${month}-${day}`;
        }

        function getTodoMetrics(todos) {
            return todos.reduce((metrics, todo) => {
                metrics.total += 1;
                if (todo.status === 'todo') metrics.todo += 1;
                if (todo.status === 'in_progress') metrics.in_progress += 1;
                if (todo.status === 'done') metrics.done += 1;
                if (todo.archived) metrics.archived += 1;
                if (isTodoDueToday(todo)) metrics.dueToday += 1;
                if (isTodoOverdue(todo)) metrics.overdue += 1;
                return metrics;
            }, { total: 0, todo: 0, in_progress: 0, done: 0, archived: 0, dueToday: 0, overdue: 0 });
        }

        function updateTodoSummary(metrics) {
            const counters = {
                todoTotalCount: metrics.total,
                todoTodoCount: metrics.todo,
                todoInProgressCount: metrics.in_progress,
                todoDoneCount: metrics.done,
                todoArchivedCount: metrics.archived,
                todoDueTodayCount: metrics.dueToday,
                todoOverdueCount: metrics.overdue
            };

            Object.entries(counters).forEach(([id, value]) => {
                const element = document.getElementById(id);
                if (element) {
                    element.textContent = String(value);
                }
            });
        }

        function updateTodoFilterOptions(todos) {
            const assigneeSelect = document.getElementById('todoFilterAssignee');
            if (!assigneeSelect) {
                return;
            }

            const previousValue = assigneeSelect.value;
            const assignees = [...new Set(
                todos
                    .map(todo => (todo.assignedTo || '').trim())
                    .filter(Boolean)
            )].sort((a, b) => a.localeCompare(b, getCurrentLocale()));

            assigneeSelect.innerHTML = [
                `<option value="">${t('todos.filterAllAssignees')}</option>`,
                ...assignees.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
            ].join('');

            assigneeSelect.value = assignees.includes(previousValue) ? previousValue : '';
        }

        function getFilteredTodos() {
            const search = (document.getElementById('todoSearch')?.value || '').trim().toLowerCase();
            const status = document.getElementById('todoFilterStatus')?.value || '';
            const assignee = document.getElementById('todoFilterAssignee')?.value || '';
            const overdueOnly = Boolean(document.getElementById('todoFilterOverdue')?.checked);
            const includeArchived = Boolean(document.getElementById('todoFilterArchived')?.checked);
            const sort = document.getElementById('todoSort')?.value || 'deadline';

            const filtered = getTodos().filter(todo => {
                if (!includeArchived && todo.archived) {
                    return false;
                }

                const searchable = [
                    todo.title,
                    todo.description,
                    todo.assignedTo,
                    todo.createdByName,
                    todo.updatedByName
                ].filter(Boolean).join(' ').toLowerCase();

                if (search && !searchable.includes(search)) {
                    return false;
                }

                if (status && todo.status !== status) {
                    return false;
                }

                if (assignee && (todo.assignedTo || '') !== assignee) {
                    return false;
                }

                if (overdueOnly && !isTodoOverdue(todo)) {
                    return false;
                }

                return true;
            });

            filtered.sort((a, b) => {
                if (sort === 'updated') {
                    const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                    const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                    return updatedB - updatedA;
                }

                if (sort === 'created') {
                    const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                    const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                    return createdB - createdA;
                }

                const dateA = getTodoDeadlineTimestamp(a);
                const dateB = getTodoDeadlineTimestamp(b);
                if (dateA !== dateB) {
                    return dateA - dateB;
                }

                const statusOrder = { in_progress: 0, todo: 1, done: 2 };
                const statusDiff = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
                if (statusDiff !== 0) {
                    return statusDiff;
                }

                const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                return updatedB - updatedA;
            });

            return filtered;
        }

        function renderTodoColumn(status, todos, canEdit) {
            const cards = todos.length > 0
                ? todos.map(todo => {
                    const description = todo.description
                        ? `<p class="todo-description">${escapeHtml(todo.description)}</p>`
                        : '';
                    const assignedTo = escapeHtml(todo.assignedTo || t('common.none'));
                    const createdBy = escapeHtml(todo.createdByName || t('common.none'));
                    const updatedBy = escapeHtml(todo.updatedByName || todo.createdByName || t('common.none'));
                    const overdueBadge = isTodoOverdue(todo)
                        ? `<span class="todo-badge overdue">${t('todos.overdueBadge')}</span>`
                        : '';
                    const updatedAt = todo.updatedAt
                        ? `<span>${t('todos.updatedAt', { date: formatDateTime(todo.updatedAt) })}</span>`
                        : '';
                    const archiveButton = todo.status === 'done'
                        ? `<button type="button" class="secondary" onclick="toggleTodoArchive('${todo.id}', ${todo.archived ? 'false' : 'true'})">${t(todo.archived ? 'todos.restore' : 'todos.archive')}</button>`
                        : '';

                    return `
                        <div class="todo-card ${todo.status} ${isTodoOverdue(todo) ? 'overdue' : ''}">
                            <div class="todo-card-header">
                                <h3>${escapeHtml(todo.title)}</h3>
                                <span class="todo-badge ${todo.status}">${getTodoStatusLabel(todo.status)}</span>
                            </div>
                            <div class="todo-meta">
                                <span class="todo-badge ${todo.status}">${t('todos.deadlineLabel', { date: formatTodoDeadline(todo) })}</span>
                                <span class="todo-badge todo">${t('todos.assignedLabel', { name: assignedTo })}</span>
                                ${overdueBadge}
                            </div>
                            ${description}
                            <div class="todo-footer">
                                <span>${t('todos.createdBy', { name: createdBy })}</span>
                                <span>${t('todos.updatedBy', { name: updatedBy })}</span>
                                ${updatedAt}
                            </div>
                            ${canEdit ? `
                            <div class="todo-actions">
                                <select aria-label="${t('todos.changeStatus')}" onchange="handleTodoStatusChange('${todo.id}', this.value)">
                                    <option value="todo" ${todo.status === 'todo' ? 'selected' : ''}>${t('todos.todo')}</option>
                                    <option value="in_progress" ${todo.status === 'in_progress' ? 'selected' : ''}>${t('todos.in_progress')}</option>
                                    <option value="done" ${todo.status === 'done' ? 'selected' : ''}>${t('todos.done')}</option>
                                </select>
                                ${archiveButton}
                                <button type="button" onclick="editTodo('${todo.id}')">${t('todos.edit')}</button>
                                <button type="button" class="danger" onclick="deleteTodo('${todo.id}')">${t('todos.delete')}</button>
                            </div>
                            ` : ''}
                        </div>
                    `;
                }).join('')
                : `<p class="todo-column-empty">${t('todos.columnEmpty')}</p>`;

            return `
                <div class="todo-column ${status}">
                    <div class="todo-column-header">
                        <div class="todo-column-title">
                            <span class="todo-column-indicator"></span>
                            <h3>${getTodoStatusLabel(status)}</h3>
                        </div>
                        <span class="todo-column-count">${todos.length}</span>
                    </div>
                    <div class="todo-column-body">${cards}</div>
                </div>
            `;
        }

        function displayTodos() {
            const list = document.getElementById('todoList');
            const resultsMeta = document.getElementById('todoResultsMeta');
            if (!list) return;

            const allTodos = getTodos();
            const metrics = getTodoMetrics(allTodos);
            updateTodoSummary(metrics);
            updateTodoFilterOptions(allTodos);

            const todos = getFilteredTodos();
            if (resultsMeta) {
                resultsMeta.textContent = t('todos.resultsLabel', {
                    visible: todos.length,
                    total: allTodos.length
                });
            }

            if (allTodos.length === 0) {
                list.innerHTML = `<div class="todo-empty">${t('todos.empty')}</div>`;
                return;
            }

            if (todos.length === 0) {
                list.innerHTML = `<div class="todo-empty">${t('todos.noResults')}</div>`;
                return;
            }

            const grouped = {
                todo: todos.filter(todo => todo.status === 'todo'),
                in_progress: todos.filter(todo => todo.status === 'in_progress'),
                done: todos.filter(todo => todo.status === 'done')
            };

            const canEdit = canManageTodos();
            list.innerHTML = [
                renderTodoColumn('todo', grouped.todo, canEdit),
                renderTodoColumn('in_progress', grouped.in_progress, canEdit),
                renderTodoColumn('done', grouped.done, canEdit)
            ].join('');
        }

        function editTodo(todoId) {
            if (!requirePermission(canManageTodos, t('alerts.permissionTodos'))) {
                return;
            }

            const todo = getTodos().find(item => item.id === todoId);
            if (!todo) return;

            editingTodoId = todoId;
            document.getElementById('todoTitle').value = todo.title || '';
            document.getElementById('todoDescription').value = todo.description || '';
            document.getElementById('todoStatus').value = todo.status || 'todo';
            document.getElementById('todoDeadline').value = todo.deadline || '';
            document.getElementById('todoDeadlineTime').value = todo.deadlineTime || '';
            document.getElementById('todoAssignedTo').value = todo.assignedTo || '';
            document.getElementById('todoSectionTitle').textContent = t('todos.editTitle');

            const submitBtn = document.querySelector('#todoForm button[type="submit"]');
            if (submitBtn) {
                submitBtn.textContent = t('todos.update');
            }

            showTab('todos');
            document.getElementById('todoForm').scrollIntoView({ behavior: 'smooth' });
        }

        async function updateTodoStatus(todoId, status) {
            if (!requirePermission(canManageTodos, t('alerts.permissionTodos'))) {
                return;
            }

            try {
                const response = await apiRequest(`/todos/${todoId}`, {
                    method: 'PATCH',
                    body: status === 'done' ? { status } : { status, archived: false }
                });
                saveTodos(getTodos().map(item => item.id === todoId ? response.item : item));
                displayTodos();
            } catch (error) {
                alert(t('alerts.todoStatusFailed', { error: error.message }));
            }
        }

        async function toggleTodoArchive(todoId, archived) {
            if (!requirePermission(canManageTodos, t('alerts.permissionTodos'))) {
                return;
            }

            try {
                const response = await apiRequest(`/todos/${todoId}`, {
                    method: 'PATCH',
                    body: { archived }
                });
                saveTodos(getTodos().map(item => item.id === todoId ? response.item : item));
                displayTodos();
            } catch (error) {
                alert(t('alerts.todoArchiveFailed', { error: error.message }));
            }
        }

        function handleTodoStatusChange(todoId, status) {
            const todo = getTodos().find(item => item.id === todoId);
            if (!todo || todo.status === status) {
                return;
            }

            updateTodoStatus(todoId, status);
        }

        async function deleteTodo(todoId) {
            if (!requirePermission(canManageTodos, t('alerts.permissionTodos'))) {
                return;
            }

            if (!confirm(t('alerts.todoDeleteConfirm'))) {
                return;
            }

            try {
                await apiRequest(`/todos/${todoId}`, { method: 'DELETE' });
                saveTodos(getTodos().filter(item => item.id !== todoId));
                displayTodos();
                updateDataStats();
            } catch (error) {
                alert(t('alerts.todoDeleteFailed', { error: error.message }));
            }
        }

        bindElementEvent('todoForm', 'submit', async function(e) {
            e.preventDefault();

            if (!requirePermission(canManageTodos, t('alerts.permissionTodos'))) {
                return;
            }

            const payload = {
                title: document.getElementById('todoTitle').value.trim(),
                description: document.getElementById('todoDescription').value.trim(),
                status: document.getElementById('todoStatus').value,
                deadline: document.getElementById('todoDeadline').value,
                deadlineTime: document.getElementById('todoDeadlineTime').value,
                assignedTo: document.getElementById('todoAssignedTo').value.trim()
            };

            if (!payload.title) {
                alert(t('alerts.todoTitleRequired'));
                return;
            }

            try {
                let response;
                if (editingTodoId) {
                    response = await apiRequest(`/todos/${editingTodoId}`, {
                        method: 'PATCH',
                        body: payload
                    });
                    saveTodos(getTodos().map(item => item.id === editingTodoId ? response.item : item));
                    alert(t('alerts.todoUpdated'));
                } else {
                    response = await apiRequest('/todos', {
                        method: 'POST',
                        body: payload
                    });
                    saveTodos([response.item, ...getTodos()]);
                    alert(t('alerts.todoCreated'));
                }

                resetTodoForm();
                displayTodos();
                updateDataStats();
            } catch (error) {
                alert(t('alerts.todoSaveFailed', { error: error.message }));
            }
        });
        
        bindElementEvent('agentForm', 'submit', async function(e) {
            e.preventDefault();

            if (!requirePermission(canManageOperationalData, 'Seuls les managers et plus peuvent gérer les agents.')) {
                return;
            }

            const isCompanyInput = document.getElementById('isCompany');
            const companyIbanInput = document.getElementById('companyIBAN');
            const companyCountryInput = document.getElementById('companyCountry');
            const companyAddressInput = document.getElementById('companyAddress');
            const companyNameInput = document.getElementById('companyName');
            const selectedCategory = document.getElementById('agentCategory').value;
            const isClientCategory = selectedCategory === 'client';
            const isCompany = isClientCategory && Boolean(isCompanyInput?.checked);
            
            const agent = {
                id: editingAgentId || Date.now().toString(),
                pseudo: document.getElementById('agentPseudo').value,
                discord: document.getElementById('agentDiscord').value,
                paymentMethods: getPaymentMethods(),
                pf: document.getElementById('agentPF').value,
                category: selectedCategory,
                commissionRate: document.getElementById('agentCommissionRate').value ? parseFloat(document.getElementById('agentCommissionRate').value) : 0,
                memberSince: document.getElementById('agentMemberSince').value || '',
                isCurrentTeamMember: document.getElementById('agentIsCurrentTeamMember').value !== 'false',
                isCompany: isCompany,
                iban: isCompany ? (companyIbanInput?.value || '') : '',
                country: isCompany ? (companyCountryInput?.value || '') : '',
                address: isCompany ? (companyAddressInput?.value || '') : '',
                companyName: isCompany ? (companyNameInput?.value || '') : ''
            };
            const { id: _agentId, ...agentPayload } = agent;
            
            const agents = getAgents();
            
            try {
                if (editingAgentId) {
                    const response = await apiRequest(`/agents/${editingAgentId}`, {
                        method: 'PATCH',
                        body: agentPayload
                    });
                    saveAgents(agents.map(item => item.id === editingAgentId ? response.item : item));
                    alert(t('alerts.agentUpdated'));
                    editingAgentId = null;
                } else {
                    const response = await apiRequest('/agents', {
                        method: 'POST',
                        body: agentPayload
                    });
                    saveAgents([...agents, response.item]);
                    alert(
                        response.credentials
                            ? t('alerts.agentCreatedWithCredentials', {
                                email: response.credentials.email,
                                password: response.credentials.password
                            })
                            : t('alerts.agentCreated')
                    );
                }

                loadAgentsIntoSelects();
                loadAgentsIntoSelector();
                resetAgentForm();
                displayAgents();
            } catch (error) {
                alert(t('alerts.agentSaveFailed', { error: error.message }));
            }
        });

        bindElementEvent('engagementEventForm', 'submit', async function (e) {
            e.preventDefault();
            if (!requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            const agentId = document.getElementById('engagementAgentSelect')?.value || '';
            if (!agentId) {
                return;
            }

            const dateInput = document.getElementById('engagementEventDate')?.value || '';
            const body = {
                type: document.getElementById('engagementEventType').value,
                note: document.getElementById('engagementEventNote').value.trim(),
                externalRef: document.getElementById('engagementExternalRef').value.trim(),
            };
            if (dateInput) {
                const parsed = new Date(dateInput);
                if (!Number.isNaN(parsed.getTime())) {
                    body.occurredAt = parsed.toISOString();
                }
            }

            try {
                const response = await apiRequest(`/agents/${agentId}/engagement-events`, {
                    method: 'POST',
                    body
                });
                const list = getAgents();
                const idx = list.findIndex((a) => a.id === agentId);
                if (idx >= 0 && response.engagement) {
                    list[idx].engagement = response.engagement;
                    saveAgents(list);
                }
                document.getElementById('engagementEventNote').value = '';
                document.getElementById('engagementExternalRef').value = '';
                document.getElementById('engagementEventDate').value = '';
                alert(t('agents.engagement.eventSaved'));
                displayAgents();
            } catch (error) {
                alert(t('agents.engagement.eventFailed', { error: error.message }));
            }
        });
        
        bindElementEvent('agentCategory', 'change', function() {
            const clientFields = document.getElementById('clientFields');
            const commissionRateFields = document.getElementById('commissionRateFields');
            const memberSinceFields = document.getElementById('memberSinceFields');
            
            if (this.value === 'client') {
                clientFields.classList.remove('hidden');
                commissionRateFields.classList.add('hidden');
                memberSinceFields.classList.add('hidden');
                document.getElementById('agentCommissionRate').removeAttribute('required');
            } else if (this.value === 'manager' || this.value === 'builder' || this.value === 'apprentice') {
                commissionRateFields.classList.remove('hidden');
                memberSinceFields.classList.remove('hidden');
                clientFields.classList.add('hidden');
                document.getElementById('agentCommissionRate').setAttribute('required', 'required');
            } else {
                commissionRateFields.classList.add('hidden');
                memberSinceFields.classList.add('hidden');
                clientFields.classList.add('hidden');
                document.getElementById('agentCommissionRate').removeAttribute('required');
            }
        });

        bindElementEvent('userRole', 'change', function() {
            syncManagedUserAccountFields();
        });
        
        const isCompanyCheckbox = document.getElementById('isCompany');
        if (isCompanyCheckbox) {
            isCompanyCheckbox.addEventListener('change', function() {
                const companyFields = document.getElementById('companyFields');
                if (!companyFields) return;

                if (this.checked) {
                    companyFields.classList.remove('hidden');
                } else {
                    companyFields.classList.add('hidden');
                }
            });
        }
        
        function engagementSortRank(status) {
            const order = { sanction: 0, warn: 1, attention: 2, active: 3 };
            return order[status] ?? 3;
        }

        function sortAgentsActiveFirst(agentList) {
            return [...agentList].sort((a, b) => {
                const aInactive = a.isCurrentTeamMember === false ? 1 : 0;
                const bInactive = b.isCurrentTeamMember === false ? 1 : 0;
                if (aInactive !== bInactive) {
                    return aInactive - bInactive;
                }
                const ae = engagementSortRank(a.engagement?.status);
                const be = engagementSortRank(b.engagement?.status);
                if (ae !== be) {
                    return ae - be;
                }
                return (a.pseudo || '').localeCompare(b.pseudo || '', undefined, { sensitivity: 'base' });
            });
        }

        function syncEngagementTypeOptions() {
            const sel = document.getElementById('engagementEventType');
            if (!sel) {
                return;
            }
            const previous = sel.value;
            const types = ['meeting_absence', 'survey_no_response', 'task_missed', 'other_inactivity'];
            sel.innerHTML = types.map((type) => (
                `<option value="${type}">${t(`agents.engagement.types.${type}`)}</option>`
            )).join('');
            if (types.includes(previous)) {
                sel.value = previous;
            }
        }

        function fillEngagementAgentSelect() {
            const sel = document.getElementById('engagementAgentSelect');
            if (!sel) {
                return;
            }
            const previous = sel.value;
            const placeholder = t('agents.engagement.selectAgent');
            sel.innerHTML = `<option value="">${placeholder}</option>`;
            sortAgentsActiveFirst(getAgents()).forEach((a) => {
                const opt = document.createElement('option');
                opt.value = a.id;
                opt.textContent = `${a.pseudo} (${getRoleLabel(a.category)})`;
                sel.appendChild(opt);
            });
            if (previous && [...sel.options].some((o) => o.value === previous)) {
                sel.value = previous;
            }
        }

        function displayAgents() {
            const agents = getAgents();
            const list = document.getElementById('agentList');
            if (!list) return;
            list.innerHTML = '';
            
            const buildersManagers = sortAgentsActiveFirst(
                agents.filter(a => a.category === 'manager' || a.category === 'builder' || a.category === 'apprentice')
            );
            const clients = sortAgentsActiveFirst(agents.filter(a => a.category === 'client'));
            
            function renderAgentCard(agent) {
                const isCurrentTeamMember = agent.isCurrentTeamMember !== false;
                const eng = agent.engagement;
                const engStatus = eng?.status || 'active';
                const engCount = typeof eng?.negativeCount === 'number' ? eng.negativeCount : 0;
                const engDays = typeof eng?.windowDays === 'number' ? eng.windowDays : 60;
                const periodStart = eng?.periodStart;
                let periodLine = '';
                if (periodStart) {
                    try {
                        const d = new Date(periodStart);
                        periodLine = `<span class="engagement-period">${t('agents.engagement.periodFrom', {
                            date: d.toLocaleDateString(getCurrentLocale(), { dateStyle: 'medium' })
                        })}</span>`;
                    } catch {
                        periodLine = '';
                    }
                }
                const engagementHtml = `
                    <div class="engagement-line">
                        <span class="badge engagement-${engStatus}">${t(`agents.engagement.status.${engStatus}`)}</span>
                        <span>${t('agents.engagement.incidentCount', { count: engCount, days: engDays })}</span>
                        ${periodLine}
                    </div>
                `;
                let paymentText = t('common.none');
                if (agent.paymentMethods && agent.paymentMethods.length > 0) {
                    paymentText = agent.paymentMethods.map(pm => {
                        const typeNames = { 'virement': 'Virement bancaire', 'paypal': 'PayPal', 'autre': 'Autre' };
                        return `${typeNames[pm.type] || pm.type}: ${pm.details}`;
                    }).join(' | ');
                } else if (agent.payment) {
                    paymentText = agent.payment;
                }
                return `
                    <div class="agent-card ${isCurrentTeamMember ? '' : 'inactive-team-member'}">
                        <h3>${agent.pseudo}</h3>
                        <p><strong>Discord:</strong> ${agent.discord}</p>
                        <p><strong>${t('agents.payment')}:</strong> ${paymentText}</p>
                        <p><strong>${t('agents.portfolio')}:</strong> ${agent.pf || t('common.none')}</p>
                        ${agent.commissionRate ? `<p><strong>${t('agents.commissionRateShort')}:</strong> ${agent.commissionRate}%</p>` : ''}
                        ${(agent.category === 'manager' || agent.category === 'builder' || agent.category === 'apprentice') && agent.memberSince ? `<p><strong>${t('agents.memberSinceShort')}:</strong> ${new Date(agent.memberSince + 'T12:00:00').toLocaleDateString(getCurrentLocale())}</p>` : ''}
                        <span class="badge ${agent.category}">${getRoleLabel(agent.category)}</span>
                        ${isCurrentTeamMember ? '' : `<span class="badge inactive-team">${t('agents.inactiveTeamBadge')}</span>`}
                        ${engagementHtml}
                        ${agent.isCompany ? `<p><strong>${t('agents.companyShort')}:</strong> ${agent.companyName}</p>` : ''}
                        ${canEditUi() ? `
                        <div style="margin-top: 15px; display: flex; gap: 10px;">
                            <button type="button" onclick="editAgent('${agent.id}')" style="flex: 1;">${t('users.edit')}</button>
                            <button type="button" onclick="deleteAgent('${agent.id}')" class="danger" style="flex: 1;">${t('common.delete')}</button>
                        </div>
                        ` : ''}
                    </div>
                `;
            }
            
            if (buildersManagers.length > 0) {
                const section = document.createElement('div');
                section.className = 'agent-list-section';
                section.innerHTML = `
                    <h3>${t('agents.buildersManagers')}</h3>
                    <div class="agent-grid">${buildersManagers.map(renderAgentCard).join('')}</div>
                `;
                list.appendChild(section);
            }
            
            if (clients.length > 0) {
                const section = document.createElement('div');
                section.className = 'agent-list-section';
                section.innerHTML = `
                    <h3>${t('agents.clients')}</h3>
                    <div class="agent-grid">${clients.map(renderAgentCard).join('')}</div>
                `;
                list.appendChild(section);
            }
            
            if (agents.length === 0) {
                list.innerHTML = `<p style="color: #64748b; padding: 24px;">${t('agents.noAgents')}</p>`;
            }

            fillEngagementAgentSelect();
        }
        
        let editingAgentId = null;
        
        function editAgent(agentId) {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            const agents = getAgents();
            const agent = agents.find(a => a.id === agentId);
            if (!agent) return;
            const clientFields = document.getElementById('clientFields');
            const commissionRateFields = document.getElementById('commissionRateFields');
            const memberSinceFields = document.getElementById('memberSinceFields');
            const companyFields = document.getElementById('companyFields');
            const sectionTitle = document.getElementById('agentSectionTitle');
            
            editingAgentId = agentId;

            if (clientFields) clientFields.classList.add('hidden');
            if (commissionRateFields) commissionRateFields.classList.add('hidden');
            if (memberSinceFields) memberSinceFields.classList.add('hidden');
            if (companyFields) companyFields.classList.add('hidden');
            
            // Pré-remplir le formulaire
            document.getElementById('agentPseudo').value = agent.pseudo;
            document.getElementById('agentDiscord').value = agent.discord;
            document.getElementById('agentPF').value = agent.pf || '';
            document.getElementById('agentCategory').value = agent.category;
            document.getElementById('agentCommissionRate').value = agent.commissionRate || '';
            document.getElementById('agentMemberSince').value = agent.memberSince || '';
            document.getElementById('agentIsCurrentTeamMember').value = agent.isCurrentTeamMember === false ? 'false' : 'true';
            
            // Restaurer les moyens de paiement
            const paymentList = document.getElementById('paymentMethodsList');
            paymentList.innerHTML = '';
            
            if (agent.paymentMethods && agent.paymentMethods.length > 0) {
                agent.paymentMethods.forEach(pm => {
                    addPaymentMethod(pm);
                });
            } else if (agent.payment) {
                // Compatibilité avec les anciennes données - convertir en nouveau format
                addPaymentMethod({
                    id: `payment_${Date.now()}`,
                    type: 'autre',
                    details: agent.payment
                });
            }
            
            // Gérer les champs conditionnels
            if (agent.category === 'client') {
                if (clientFields) clientFields.classList.remove('hidden');
                document.getElementById('isCompany').checked = agent.isCompany || false;
                if (agent.isCompany) {
                    if (companyFields) companyFields.classList.remove('hidden');
                    document.getElementById('companyIBAN').value = agent.iban || '';
                    document.getElementById('companyCountry').value = agent.country || '';
                    document.getElementById('companyAddress').value = agent.address || '';
                    document.getElementById('companyName').value = agent.companyName || '';
                }
            } else if (agent.category === 'manager' || agent.category === 'builder' || agent.category === 'apprentice') {
                if (commissionRateFields) commissionRateFields.classList.remove('hidden');
                if (memberSinceFields) memberSinceFields.classList.remove('hidden');
            }

            if (sectionTitle) {
                sectionTitle.textContent = t('agents.editAgent');
            }
            
            // Changer le texte du bouton
            const submitBtn = document.querySelector('#agentForm button[type="submit"]');
            if (submitBtn) {
                submitBtn.textContent = t('agents.editAgent');
            }
            
            // Aller à l'onglet agents
            const agentsTab = document.querySelector('#tabAgentsBtn');
            if (agentsTab) {
                if (typeof showTab === 'function') {
                    showTab('agents', agentsTab);
                } else if (agentsTab.href) {
                    window.location.href = agentsTab.href;
                    return;
                }
            }
            document.getElementById('agentForm').scrollIntoView({ behavior: 'smooth' });
        }
        
        async function deleteAgent(agentId) {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            const agents = getAgents();
            const agent = agents.find(a => a.id === agentId);
            if (!agent) return;
            
            // Vérifier si l'agent est utilisé dans des commissions
            const commissions = getCommissions();
            const usedInCommissions = commissions.filter(c => {
                const realizedBy = Array.isArray(c.realizedBy) ? c.realizedBy : [c.realizedBy];
                return realizedBy.includes(agent.pseudo) || 
                       c.clientName === agent.pseudo ||
                       (c.selectedAgents && c.selectedAgents.includes(agent.pseudo));
            });
            
            if (usedInCommissions.length > 0) {
                if (!confirm(`⚠️ Cet agent est utilisé dans ${usedInCommissions.length} commission(s). Voulez-vous vraiment le supprimer ?`)) {
                    return;
                }
            } else {
                if (!confirm(`Êtes-vous sûr de vouloir supprimer l'agent "${agent.pseudo}" ?`)) {
                    return;
                }
            }
            
            try {
                await apiRequest(`/agents/${agentId}`, { method: 'DELETE' });
                const updatedAgents = agents.filter(a => a.id !== agentId);
                saveAgents(updatedAgents);
                
                loadAgentsIntoSelects();
                loadAgentsIntoSelector();
                displayAgents();
                
                alert(t('common.deletedSuccess'));
            } catch (error) {
                alert(t('alerts.agentDeleteFailed', { error: error.message }));
            }
        }
        
        function resetAgentForm() {
            const form = document.getElementById('agentForm');
            const clientFields = document.getElementById('clientFields');
            const commissionRateFields = document.getElementById('commissionRateFields');
            const memberSinceFields = document.getElementById('memberSinceFields');
            const companyFields = document.getElementById('companyFields');
            const paymentMethodsList = document.getElementById('paymentMethodsList');
            if (!form || !clientFields || !commissionRateFields || !memberSinceFields || !companyFields || !paymentMethodsList) return;

            form.reset();
            clientFields.classList.add('hidden');
            commissionRateFields.classList.add('hidden');
            memberSinceFields.classList.add('hidden');
            companyFields.classList.add('hidden');
            paymentMethodsList.innerHTML = '';
            editingAgentId = null;
            document.getElementById('agentIsCurrentTeamMember').value = 'true';

            const submitBtn = document.querySelector('#agentForm button[type="submit"]');
            if (submitBtn) {
                submitBtn.textContent = t('agents.addAgent');
            }
            const sectionTitle = document.getElementById('agentSectionTitle');
            if (sectionTitle) {
                sectionTitle.textContent = t('agents.addTitle');
            }
        }
        
        // Gestion des boutons Oui/Non
        document.querySelectorAll('.yes-no-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const group = this.closest('.form-group');
                const hiddenInput = group.querySelector('input[type="hidden"]');
                const buttons = group.querySelectorAll('.yes-no-btn');
                
                buttons.forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                hiddenInput.value = this.dataset.value;
            });
        });
        
        // Stockage de la répartition actuelle
        let currentDistribution = {};
        
        // Gestion de la répartition des prix (montants en € par agent) — les agents sélectionnés = "réalisé par"
        function updatePriceDistribution() {
            const selectedAgents = Array.from(document.querySelectorAll('#agentSelector input[type="checkbox"]:checked'))
                .map(cb => cb.value);
            const distribution = document.getElementById('priceDistribution');
            distribution.innerHTML = '';
            
            if (selectedAgents.length === 0) {
                return;
            }
            
            // currentDistribution[agent] = { amount, percent } — par défaut percent = taux commission de l'agent
            const agents = getAgents();
            selectedAgents.forEach(agentPseudo => {
                if (currentDistribution[agentPseudo] === undefined || typeof currentDistribution[agentPseudo] === 'number') {
                    const agentData = agents.find(a => a.pseudo === agentPseudo);
                    const defaultPercent = agentData?.commissionRate ?? 0;
                    currentDistribution[agentPseudo] = {
                        amount: typeof currentDistribution[agentPseudo] === 'number' ? currentDistribution[agentPseudo] : 0,
                        percent: defaultPercent,
                        paid: false
                    };
                }
                if (currentDistribution[agentPseudo] && currentDistribution[agentPseudo].paid === undefined) {
                    currentDistribution[agentPseudo].paid = false;
                }
            });
            Object.keys(currentDistribution).forEach(agent => {
                if (!selectedAgents.includes(agent)) delete currentDistribution[agent];
            });
            
            selectedAgents.forEach((agent, index) => {
                const div = document.createElement('div');
                div.className = 'price-item';
                const data = currentDistribution[agent] || { amount: 0, percent: 0, paid: false };
                const amountVal = typeof data === 'object' ? (data.amount ?? 0) : data;
                const percentVal = typeof data === 'object' ? (data.percent ?? 0) : 0;
                const paidVal = typeof data === 'object' && data.paid === true;
                div.innerHTML = `
                    <label>Agent ${index + 1} - ${agent}</label>
                    <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; margin-top: 6px; align-items: end;">
                        <div>
                            <label style="font-size: 12px; color: #666;">Répartition (€)</label>
                            <input type="number" id="amount_${agent}" min="0" step="0.01" value="${amountVal}" placeholder="0.00" oninput="updateDistributionForAgent('${agent}', 'amount', this.value)" style="width: 100%; padding: 10px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px;">
                        </div>
                        <div>
                            <label style="font-size: 12px; color: #666;">Taxe (%)</label>
                            <input type="number" id="percent_${agent}" min="0" max="100" step="0.01" value="${percentVal}" placeholder="0" oninput="updateDistributionForAgent('${agent}', 'percent', this.value)" style="width: 100%; padding: 10px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px;">
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px; padding-bottom: 2px;">
                            <input type="checkbox" id="paid_${agent}" ${paidVal ? 'checked' : ''} onchange="updateDistributionForAgent('${agent}', 'paid', this.checked)" style="width: 18px; height: 18px; cursor: pointer;">
                            <label for="paid_${agent}" style="font-size: 13px; color: #666; margin: 0; cursor: pointer; white-space: nowrap;">Payé ?</label>
                        </div>
                    </div>
                `;
                distribution.appendChild(div);
            });
            
            // Ajouter l'affichage du total
            const totalDiv = document.createElement('div');
            totalDiv.id = 'totalAmount';
            totalDiv.className = 'total-percentage valid';
            distribution.appendChild(totalDiv);
            
            updateTotalAmount();
            updateWhoTookWhat();
        }
        
        function updateDistributionForAgent(agent, field, newValue) {
            if (!currentDistribution[agent] || typeof currentDistribution[agent] !== 'object') {
                currentDistribution[agent] = { amount: 0, percent: 0, paid: false };
            }
            if (field === 'amount') {
                const num = parseFloat(newValue) || 0;
                currentDistribution[agent].amount = Math.max(0, num);
            } else if (field === 'percent') {
                const num = parseFloat(newValue) || 0;
                currentDistribution[agent].percent = Math.max(0, Math.min(100, num));
            } else if (field === 'paid') {
                currentDistribution[agent].paid = newValue === true || newValue === 'true';
                return;
            }
            updateTotalAmount();
            updateWhoTookWhat();
        }
        
        // Prix total = somme des répartitions (la taxe n'est pas incluse dans le total)
        function getCalculatedPrice() {
            const selectedAgents = Array.from(document.querySelectorAll('#agentSelector input[type="checkbox"]:checked'))
                .map(cb => cb.value);
            let total = 0;
            selectedAgents.forEach(agent => {
                const d = currentDistribution[agent];
                const amount = (d && typeof d === 'object' ? d.amount : d) || 0;
                total += amount;
            });
            return total;
        }
        
        function updateTotalAmount() {
            const selectedAgents = Array.from(document.querySelectorAll('#agentSelector input[type="checkbox"]:checked'))
                .map(cb => cb.value);
            let sumAmounts = 0;
            
            selectedAgents.forEach(agent => {
                const amountInput = document.getElementById(`amount_${agent}`);
                const percentInput = document.getElementById(`percent_${agent}`);
                const amount = amountInput ? (parseFloat(amountInput.value) || 0) : (currentDistribution[agent]?.amount ?? 0);
                const percent = percentInput ? (parseFloat(percentInput.value) || 0) : (currentDistribution[agent]?.percent ?? 0);
                if (!currentDistribution[agent] || typeof currentDistribution[agent] !== 'object') {
                    currentDistribution[agent] = { amount: 0, percent: 0 };
                }
                currentDistribution[agent].amount = amount;
                currentDistribution[agent].percent = Math.min(100, Math.max(0, percent));
                sumAmounts += amount;
            });
            
            const calculatedPrice = getCalculatedPrice();
            const totalDiv = document.getElementById('totalAmount');
            if (totalDiv) {
                totalDiv.textContent = `Prix total (calculé) : ${calculatedPrice.toFixed(2)} €`;
                totalDiv.className = 'total-percentage valid';
            }
            const depositEl = document.getElementById('depositAmount');
            if (depositEl && calculatedPrice > 0 && (depositEl.value === '' || parseFloat(depositEl.value) === 0)) {
                depositEl.value = (calculatedPrice / 2).toFixed(2);
            }
        }
        
        function updateWhoTookWhat() {
            const selectedAgents = Array.from(document.querySelectorAll('#agentSelector input[type="checkbox"]:checked'))
                .map(cb => cb.value);
            const whoTookWhat = document.getElementById('whoTookWhat');
            
            // Prix total = somme des répartitions
            const totalPrice = getCalculatedPrice();
            
            whoTookWhat.innerHTML = '';
            
            if (totalPrice === 0) {
                return;
            }
            
            // Taxe Lusciana = Σ (répartition × %/100) — ce que chaque agent paie
            let luscianaCommission = 0;
            const agentDetails = [];
            selectedAgents.forEach(agent => {
                const d = currentDistribution[agent];
                const amount = (d && typeof d === 'object' ? d.amount : d) || 0;
                const percent = (d && typeof d === 'object' ? d.percent : 0) || 0;
                if (amount > 0) {
                    const tax = amount * (percent / 100);
                    luscianaCommission += tax;
                    agentDetails.push({
                        name: agent,
                        amount: amount * (1 - percent / 100),
                        taxPaid: tax,
                        percent: percent.toFixed(1)
                    });
                }
            });
            
            // Créer l'affichage
            const container = document.createElement('div');
            container.style.cssText = 'padding: 15px; background: #f8f9fa; border-radius: 8px; border: 2px solid #e0e0e0;';
            
            let html = '<h3 style="margin-bottom: 15px; color: #333; font-size: 18px;">💰 Répartition des gains</h3>';
            
            // Afficher Lusciana (taxe perçue = ce que les agents paient)
            html += `
                <div style="margin-bottom: 15px; padding: 12px; background: white; border-radius: 6px; border-left: 4px solid #667eea;">
                    <p style="margin: 0; font-weight: 600; color: #667eea; font-size: 16px;">🏢 Lusciana (taxe perçue)</p>
                    <p style="margin: 5px 0 0 0; font-size: 18px; color: #333;"><strong>${luscianaCommission.toFixed(2)}€</strong></p>
                </div>
            `;
            
            // Afficher les agents (builders/managers)
            if (agentDetails.length > 0) {
                html += '<div style="margin-top: 15px;"><p style="font-weight: 600; margin-bottom: 10px; color: #333;">Agents :</p>';
                agentDetails.forEach(agent => {
                    html += `
                        <div style="margin-bottom: 10px; padding: 10px; background: white; border-radius: 6px; border-left: 4px solid #28a745;">
                            <p style="margin: 0; font-weight: 600; color: #28a745;">${agent.name} (${agent.percent}%)</p>
                            <p style="margin: 5px 0 0 0; font-size: 16px; color: #333;"><strong>${agent.amount.toFixed(2)}€</strong></p>
                        </div>
                    `;
                });
                html += '</div>';
            }
            
            container.innerHTML = html;
            whoTookWhat.appendChild(container);
            
            updateTotalAmount();
        }
        
        // Gestion du feedback client (uniquement sur la page avec le formulaire commission)
        (function initClientFeedbackYesNo() {
            const hasFeedbackEl = document.querySelector('#hasFeedback');
            const row = hasFeedbackEl ? hasFeedbackEl.previousElementSibling : null;
            if (!row) {
                return;
            }
            row.querySelectorAll('.yes-no-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const feedbackGroup = document.getElementById('feedbackGroup');
                    if (!feedbackGroup) {
                        return;
                    }
                    if (this.dataset.value === 'yes') {
                        feedbackGroup.classList.remove('hidden');
                    } else {
                        feedbackGroup.classList.add('hidden');
                    }
                });
            });
        })();
        
        // Génération du texte showcase
        function generateShowcaseText(commission) {
            const size = commission.buildSize.includes('x') ? commission.buildSize : `${commission.buildSize}x${commission.buildSize}`;
            const buildName = commission.buildName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            
            // Gérer plusieurs builders
            let realizedBy = commission.realizedBy;
            if (Array.isArray(realizedBy)) {
                const builders = realizedBy.map(b => b.charAt(0).toUpperCase() + b.slice(1).toLowerCase());
                if (builders.length === 1) {
                    realizedBy = builders[0];
                } else if (builders.length === 2) {
                    realizedBy = `${builders[0]} & ${builders[1]}`;
                } else {
                    realizedBy = builders.slice(0, -1).join(', ') + ` & ${builders[builders.length - 1]}`;
                }
            } else if (typeof realizedBy === 'string') {
                // Compatibilité avec les anciennes données
                realizedBy = realizedBy.charAt(0).toUpperCase() + realizedBy.slice(1).toLowerCase();
            }
            
            const version = commission.version;
            const forCustomer = commission.forCustomer === 'yes' ? '' : commission.forCustomer;
            const collaboration = Array.isArray(commission.realizedBy) && commission.realizedBy.length > 1 ? 
                (commission.forCustomer === 'yes' ? 'In collaboration' : '') : '';
            const collaborationFr = Array.isArray(commission.realizedBy) && commission.realizedBy.length > 1 ? 
                (commission.forCustomer === 'yes' ? 'En collaboration' : '') : '';
            
            return `> :sparkles: **Lusciana - New Build Showcase**
> **${buildName}**
> :link: [Order a custom map](https://lusciana.fr/devis) - .gg/lusciana

${buildName}
Size : ${size}
${forCustomer}
${collaboration}
By ${realizedBy}

${buildName}
Taille : ${size}
${forCustomer}
${collaborationFr}
Par ${realizedBy}

Version : ${version}`;
        }
        
        // Enregistrement de la commission
        bindElementEvent('commissionForm', 'submit', async function(e) {
            e.preventDefault();

            if (!requirePermission(canManageOperationalData, 'Seuls les managers et plus peuvent gérer les commissions.')) {
                return;
            }
            
            const worldNameVal = (document.getElementById('worldName').value || '').trim();
            if (!worldNameVal.toLowerCase().startsWith('c-')) {
                alert(t('alerts.worldPrefixRequired'));
                document.getElementById('worldName').focus();
                return;
            }
            const selectedAgents = Array.from(document.querySelectorAll('#agentSelector input[type="checkbox"]:checked')).map(cb => cb.value);
            const calculatedPrice = getCalculatedPrice();
            
            const commission = {
                id: editingCommissionId || Date.now().toString(),
                buildSize: document.getElementById('buildSize').value,
                buildName: document.getElementById('buildName').value,
                worldName: worldNameVal,
                realizedBy: selectedAgents,
                version: document.getElementById('version').value,
                forCustomer: document.getElementById('forCustomer').value,
                price: calculatedPrice,
                buildStart: document.getElementById('buildStart').value,
                buildEnd: document.getElementById('buildEnd').value,
                depositPaid: document.getElementById('depositPaid').value,
                depositAmount: parseFloat(document.getElementById('depositAmount').value) || 0,
                buildType: document.querySelector('input[name="buildType"]:checked').value,
                organics: document.getElementById('organics').value,
                selectedAgents: selectedAgents,
                priceDistribution: {},
                commissionPercent: parseFloat(document.getElementById('commissionPercent').value) || 0,
                wentWell: document.getElementById('wentWell').value,
                clientName: document.getElementById('clientName').value,
                clientWants: document.getElementById('clientWants').value,
                hasFeedback: document.getElementById('hasFeedback').value,
                clientFeedback: document.getElementById('clientFeedbackText').value || '',
                render: document.getElementById('render').value,
                showcaseText: '',
                createdAt: new Date().toISOString()
            };
            
            // Récupérer la répartition (montant + % + payé par agent)
            commission.selectedAgents.forEach(agent => {
                const d = currentDistribution[agent];
                const amount = (d && typeof d === 'object' ? d.amount : d) || 0;
                const percent = (d && typeof d === 'object' ? d.percent : 0) || 0;
                const paid = (d && typeof d === 'object' && d.paid === true);
                commission.priceDistribution[agent] = {
                    price: amount,
                    percent: Math.round(percent * 10) / 10,
                    paid: paid
                };
            });
            
            // Générer le texte showcase
            commission.showcaseText = generateShowcaseText(commission);
            const { id: _commissionId, ...commissionPayload } = commission;
            
            try {
                const commissions = getCommissions();

                if (editingCommissionId) {
                    commission.createdAt = (commissions.find(c => c.id === editingCommissionId) || {}).createdAt || commission.createdAt;
                    const response = await apiRequest(`/commissions/${editingCommissionId}`, {
                        method: 'PATCH',
                        body: commissionPayload
                    });
                    saveCommissions(commissions.map(item => item.id === editingCommissionId ? response.item : item));
                    alert(t('commissions.generatedPrice', { price: calculatedPrice.toFixed(2) }));
                    editingCommissionId = null;
                } else {
                    const response = await apiRequest('/commissions', {
                        method: 'POST',
                        body: commissionPayload
                    });
                    saveCommissions([...commissions, response.item]);
                    const showcaseCopied = await copyTextToClipboard(commission.showcaseText);
                    alert(
                        showcaseCopied
                            ? `${t('commissions.generatedPrice', { price: calculatedPrice.toFixed(2) })}\n\n${t('commissions.showcaseCopied')}`
                            : `${t('commissions.generatedPrice', { price: calculatedPrice.toFixed(2) })}\n\n${t('commissions.showcaseNotCopied')}`
                    );
                }

                showCommissionList();
            } catch (error) {
                alert(error.message);
            }
        });
        
        function resetForm() {
            document.getElementById('commissionForm').reset();
            document.getElementById('agentSelector').innerHTML = '';
            document.getElementById('priceDistribution').innerHTML = '';
            document.getElementById('whoTookWhat').innerHTML = '';
            document.getElementById('feedbackGroup').classList.add('hidden');
            
            editingCommissionId = null;
            currentDistribution = {};
            document.getElementById('newClientForm').classList.add('hidden');
            
            // Réinitialiser les boutons oui/non
            document.querySelectorAll('.yes-no-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            document.getElementById('forCustomer').value = 'yes';
            document.getElementById('wentWell').value = 'yes';
            document.querySelectorAll('.yes-no-btn.no').forEach(btn => {
                if (btn.closest('.form-group').querySelector('input[type="hidden"]').id === 'depositPaid' || 
                    btn.closest('.form-group').querySelector('input[type="hidden"]').id === 'organics' ||
                    btn.closest('.form-group').querySelector('input[type="hidden"]').id === 'hasFeedback') {
                    btn.classList.add('active');
                }
            });
            
            // Remettre le texte du bouton
            const submitBtn = document.querySelector('#commissionForm button[type="submit"]');
            if (submitBtn) {
                submitBtn.textContent = t('commissions.saveNew');
            }
            
            loadAgentsIntoSelector();
        }
        
        function displayCommissions() {
            const commissions = getCommissions();
            const list = document.getElementById('commissionList');
            if (!list) return;
            list.innerHTML = '';
            
            if (commissions.length === 0) {
                list.innerHTML = `<p style="text-align: center; color: #64748b; padding: 48px 24px; font-size: 15px;">${t('commissions.empty')}</p>`;
                return;
            }
            
            const escapeHtml = (s) => {
                if (s == null) return '';
                const div = document.createElement('div');
                div.textContent = s;
                return div.innerHTML;
            };
            const realizedByStr = (c) => Array.isArray(c.realizedBy) ? c.realizedBy.join(', ') : (c.realizedBy || '—');
            const formatDate = (d) => d ? new Date(d).toLocaleDateString(getCurrentLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
            
            const isCommissionFinished = (c) => {
                if (!c.priceDistribution || Object.keys(c.priceDistribution).length === 0) return false;
                return Object.keys(c.priceDistribution).every(agent => c.priceDistribution[agent].paid === true);
            };
            
            const sorted = [...commissions].sort((a, b) => {
                const dateA = a.buildStart ? new Date(a.buildStart).getTime() : 0;
                const dateB = b.buildStart ? new Date(b.buildStart).getTime() : 0;
                return dateB - dateA;
            });
            sorted.forEach(commission => {
                const card = document.createElement('div');
                const finished = isCommissionFinished(commission);
                card.className = 'commission-card ' + (finished ? 'finished' : 'in-progress');
                const price = commission.price != null ? Number(commission.price).toFixed(2) : '0.00';
                const statusBadge = finished
                    ? `<span class="commission-card-badge finished">${t('commissions.finished')}</span>`
                    : `<span class="commission-card-badge in-progress">${t('commissions.inProgress')}</span>`;
                card.innerHTML = `
                    <div class="commission-card-header">
                        <h3>${escapeHtml(commission.buildName)} ${statusBadge}</h3>
                        <span class="commission-card-price">${price} €</span>
                    </div>
                    <div class="commission-card-body">
                        <div class="info-grid">
                            <div class="info-row">
                                <span class="info-label">${t('commissions.infoSize')}</span>
                                <span class="info-value">${escapeHtml(commission.buildSize)}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">${t('commissions.infoWorld')}</span>
                                <span class="info-value">${escapeHtml(commission.worldName || '—')}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">${t('commissions.infoClient')}</span>
                                <span class="info-value">${escapeHtml(commission.clientName)}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">${t('commissions.infoRealizedBy')}</span>
                                <span class="info-value">${escapeHtml(realizedByStr(commission))}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">${t('commissions.infoVersion')}</span>
                                <span class="info-value">${escapeHtml(commission.version || '—')}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">${t('commissions.infoStart')}</span>
                                <span class="info-value">${formatDate(commission.buildStart)}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">${t('commissions.infoEnd')}</span>
                                <span class="info-value">${formatDate(commission.buildEnd)}</span>
                            </div>
                        </div>
                        <div class="commission-card-actions">
                            <button type="button" onclick="copyShowcaseText('${commission.id}')">${t('commissions.copyShowcase')}</button>
                            ${canEditUi() ? `<button type="button" onclick="editCommission('${commission.id}')">${t('commissions.edit')}</button>` : ''}
                            ${canEditUi() ? `<button type="button" onclick="deleteCommission('${commission.id}')" class="danger">${t('commissions.delete')}</button>` : ''}
                        </div>
                    </div>
                `;
                list.appendChild(card);
            });
        }
        
        let editingCommissionId = null;
        
        function editCommission(commissionId) {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            const commissions = getCommissions();
            const commission = commissions.find(c => c.id === commissionId);
            if (!commission) return;
            
            editingCommissionId = commissionId;
            
            // Pré-remplir le formulaire
            document.getElementById('buildSize').value = commission.buildSize;
            document.getElementById('buildName').value = commission.buildName;
            document.getElementById('worldName').value = commission.worldName || 'c-';
            loadAgentsIntoSelects();
            document.getElementById('version').value = commission.version;
            document.getElementById('buildStart').value = commission.buildStart;
            document.getElementById('buildEnd').value = commission.buildEnd;
            document.getElementById('commissionPercent').value = commission.commissionPercent || '';
            document.getElementById('clientName').value = commission.clientName;
            document.getElementById('clientWants').value = commission.clientWants || '';
            document.getElementById('render').value = commission.render || '';
            document.getElementById('forCustomer').value = commission.forCustomer || 'yes';
            document.getElementById('wentWell').value = commission.wentWell || 'yes';
            
            // Boutons Oui/Non
            setYesNoButton('depositPaid', commission.depositPaid);
            document.getElementById('depositAmount').value = commission.depositAmount || '';
            setYesNoButton('organics', commission.organics);
            setYesNoButton('hasFeedback', commission.hasFeedback);
            
            // Build type
            const buildTypeRadio = document.querySelector(`input[name="buildType"][value="${commission.buildType}"]`);
            if (buildTypeRadio) buildTypeRadio.checked = true;
            
            // Feedback client
            if (commission.hasFeedback === 'yes') {
                document.getElementById('feedbackGroup').classList.remove('hidden');
                document.getElementById('clientFeedbackText').value = commission.clientFeedback || '';
            }
            
            // Sélectionner les agents et restaurer répartition + % par agent
            loadAgentsIntoSelector();
            setTimeout(() => {
                if (commission.selectedAgents) {
                    if (commission.priceDistribution) {
                        Object.keys(commission.priceDistribution).forEach(agent => {
                            const dist = commission.priceDistribution[agent];
                            const amount = dist && (dist.price !== undefined && dist.price !== null) ? dist.price : 0;
                            const percent = dist && (dist.percent !== undefined && dist.percent !== null) ? dist.percent : 0;
                            const paid = dist && dist.paid === true;
                            currentDistribution[agent] = { amount: amount, percent: percent, paid: paid };
                        });
                    }
                    commission.selectedAgents.forEach(agent => {
                        const checkbox = document.getElementById(`agent_${agent}`);
                        if (checkbox) checkbox.checked = true;
                    });
                    updatePriceDistribution();
                    updateWhoTookWhat();
                }
            }, 100);
            
            // Changer le texte du bouton
            const submitBtn = document.querySelector('#commissionForm button[type="submit"]');
            if (submitBtn) {
                submitBtn.textContent = t('commissions.saveEdit');
            }
            
            showTab('list');
            showCommissionForm();
            document.getElementById('commissionForm').scrollIntoView({ behavior: 'smooth' });
        }
        
        function showCommissionForm() {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            const listView = document.getElementById('commissionListView');
            const formView = document.getElementById('commissionFormView');
            if (listView) listView.style.display = 'none';
            if (formView) formView.style.display = 'block';
        }
        
        function showCommissionList() {
            const listView = document.getElementById('commissionListView');
            const formView = document.getElementById('commissionFormView');
            if (formView) formView.style.display = 'none';
            if (listView) listView.style.display = 'block';
            resetForm();
            displayCommissions();
        }
        
        function setYesNoButton(fieldId, value) {
            const hiddenInput = document.getElementById(fieldId);
            if (!hiddenInput) return;
            
            const group = hiddenInput.closest('.form-group');
            const buttons = group.querySelectorAll('.yes-no-btn');
            buttons.forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.value === value) {
                    btn.classList.add('active');
                }
            });
            hiddenInput.value = value;
        }
        
        async function deleteCommission(commissionId) {
            if (!requirePermission(canManageOperationalData, t('alerts.permissionAgents'))) {
                return;
            }

            if (!confirm(t('alerts.genericConfirmDelete'))) {
                return;
            }

            try {
                await apiRequest(`/commissions/${commissionId}`, { method: 'DELETE' });
                const commissions = getCommissions();
                const updatedCommissions = commissions.filter(c => c.id !== commissionId);
                saveCommissions(updatedCommissions);
                
                displayCommissions();
                alert(t('common.deletedSuccess'));
            } catch (error) {
                alert(error.message);
            }
        }
        
        function copyShowcaseText(commissionId) {
            const commissions = getCommissions();
            const commission = commissions.find(c => c.id === commissionId);
            if (commission && commission.showcaseText) {
                copyTextToClipboard(commission.showcaseText)
                    .then(copied => {
                        alert(copied ? t('alerts.showcaseCopied') : t('alerts.showcaseNotCopied'));
                    })
                    .catch(error => {
                        alert(t('alerts.showcaseCopyFailed', { error: error.message }));
                    });
            }
        }
        
        // Gestion des données
        function updateDataStats() {
            const agents = getAgents();
            const commissions = getCommissions();
            const todos = getTodos();
            const agentCount = document.getElementById('agentCount');
            const commissionCount = document.getElementById('commissionCount');
            const todoCount = document.getElementById('todoCount');
            const storageSize = document.getElementById('storageSize');

            if (agentCount) agentCount.textContent = agents.length;
            if (commissionCount) commissionCount.textContent = commissions.length;
            if (todoCount) todoCount.textContent = todos.length;
            if (storageSize) storageSize.textContent = accessToken ? t('data.storageRemote') : t('data.storageLoggedOut');
        }
        
        let analystChartMonthly = null;
        let analystChartByAgent = null;
        let allTransactions = [];

        bindElementEvent('loginForm', 'submit', async function(e) {
            e.preventDefault();

            const email = document.getElementById('loginEmail').value.trim();
            const password = document.getElementById('loginPassword').value;
            if (!email || !password) {
                alert(t('alerts.authLoginRequired'));
                return;
            }

            try {
                setAuthStatus(t('alerts.authInProgress'), false);
                await login(email, password);
                this.reset();
            } catch (error) {
                clearSessionData();
                setAuthenticatedState(false);
                setAuthStatus(t('alerts.authDenied'), true);
                alert(t('alerts.authLoginFailed', { error: formatFetchError(error) }));
            }
        });

        bindElementEvent('accountForm', 'submit', async function(e) {
            e.preventDefault();

            if (!accountProfile || !accountProfile.agent) {
                return;
            }

            const payload = {
                discord: document.getElementById('accountDiscord').value.trim(),
                pf: document.getElementById('accountPF').value.trim(),
                paymentMethods: getAccountPaymentMethods()
            };

            try {
                const response = await apiRequest('/account', {
                    method: 'PATCH',
                    body: payload
                });

                accountProfile = response;
                currentUser = response.user;
                accountProfile.user = response.user;
                agentsCache = getAgents().map(agent => String(agent.id) === String(response.agent.id) ? response.agent : agent);
                usersCache = getUsers().map(user => String(user.id) === String(response.user.id) ? response.user : user);
                populateAccountForm();
                updateAuthUI();
                displayAgents();
                displayUsers();
                persistAuthSession();
                alert(t('alerts.accountSaved'));
            } catch (error) {
                alert(t('alerts.accountSaveFailed', { error: error.message }));
            }
        });

        bindElementEvent('accountPasswordForm', 'submit', async function(e) {
            e.preventDefault();

            const currentPassword = document.getElementById('accountCurrentPassword').value;
            const newPassword = document.getElementById('accountNewPassword').value;

            if (!currentPassword || !newPassword) {
                alert(t('alerts.passwordFieldsRequired'));
                return;
            }

            try {
                await apiRequest('/auth/change-password', {
                    method: 'POST',
                    body: { currentPassword, newPassword }
                });
                this.reset();
                alert(t('alerts.passwordChanged'));
            } catch (error) {
                alert(t('alerts.passwordChangeFailed', { error: error.message }));
            }
        });

        bindElementEvent('languageSelect', 'change', function() {
            setCurrentLanguage(this.value);
        });

        function initializeApp() {
            currentLanguage = getInitialLanguage();
            migrateLegacyAuthStorage();
            resetDataCaches();
            const hasSession = hydrateAuthFromSessionStorage();
            setAuthenticatedState(hasSession);
            applyStaticTranslations();
            refreshUIAfterLoad();
            resetUserForm();
            resetTodoForm();
            resetAgentForm();
        }

        initializeApp();
        
        function isCommissionFinished(c) {
            if (!c.priceDistribution || Object.keys(c.priceDistribution).length === 0) return false;
            return Object.keys(c.priceDistribution).every(agent => c.priceDistribution[agent].paid === true);
        }
        
        /** Pour le Data Analyst : commission terminée = prix total ; commission en cours = uniquement l'acompte perçu (pas le prix total). */
        function getCommissionAmountForAnalyst(c) {
            if (isCommissionFinished(c)) return Number(c.price) || 0;
            return Number(c.depositAmount) || 0;
        }
        
        function buildAllTransactions() {
            const commissions = getCommissions();
            const agents = getAgents();
            const expenses = getExpenses();
            const list = [];
            
            commissions.forEach(c => {
                const dateStr = c.buildEnd || c.buildStart || c.createdAt;
                const dateSort = dateStr ? new Date(dateStr).getTime() : 0;
                const finished = isCommissionFinished(c);
                const amountForAnalyst = getCommissionAmountForAnalyst(c);
                list.push({
                    date: dateStr,
                    dateSort,
                    type: 'commission',
                    label: c.buildName + (finished ? '' : ' (acompte)'),
                    amount: amountForAnalyst,
                    currency: 'EUR',
                    clientName: c.clientName
                });
                if (finished && c.priceDistribution) {
                    Object.keys(c.priceDistribution).forEach(agentPseudo => {
                        const d = c.priceDistribution[agentPseudo];
                        const amount = Number(d?.price) || 0;
                        const percent = Number(d?.percent) || 0;
                        const net = amount * (1 - percent / 100);
                        const agent = agents.find(a => a.pseudo === agentPseudo);
                        const category = agent?.category === 'manager' ? 'manager' : 'builder';
                        list.push({
                            date: dateStr,
                            dateSort,
                            type: category,
                            label: `Paiement à ${agentPseudo}`,
                            amount: -net,
                            currency: 'EUR',
                            agentPseudo,
                            buildName: c.buildName
                        });
                    });
                }
            });
            expenses.forEach(e => {
                const dateSort = e.date ? new Date(e.date + 'T12:00:00').getTime() : 0;
                list.push({
                    date: e.date,
                    dateSort,
                    type: 'expense',
                    label: e.label,
                    amount: -(Number(e.amount) || 0),
                    currency: e.currency || 'EUR'
                });
            });
            list.sort((a, b) => b.dateSort - a.dateSort);
            allTransactions = list;
        }
        
        function renderTransactionsList() {
            const filter = document.getElementById('transactionFilter')?.value || 'all';
            const filterClient = document.getElementById('transactionFilterClient');
            const filterClientVal = filterClient?.value || '';
            if (filter === 'client') {
                filterClient?.classList.remove('hidden');
                const clients = [...new Set(allTransactions.filter(t => t.type === 'commission').map(t => t.clientName).filter(Boolean))].sort();
                filterClient.innerHTML = `<option value="">${t('analyst.filterClientPlaceholder')}</option>` + clients.map(c => `<option value="${c}">${c}</option>`).join('');
                if (filterClientVal) filterClient.value = filterClientVal;
            } else {
                filterClient?.classList.add('hidden');
            }
            let filtered = allTransactions;
            if (filter === 'commission') filtered = allTransactions.filter(t => t.type === 'commission');
            else if (filter === 'expense') filtered = allTransactions.filter(t => t.type === 'expense');
            else if (filter === 'builder') filtered = allTransactions.filter(t => t.type === 'builder');
            else if (filter === 'manager') filtered = allTransactions.filter(t => t.type === 'manager');
            else if (filter === 'client') {
                filtered = allTransactions.filter(t => t.type === 'commission');
                if (filterClientVal) filtered = filtered.filter(t => t.clientName === filterClientVal);
            }
            const wrap = document.getElementById('transactionsListWrap');
            if (!wrap) return;
            const formatDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
            const typeLabels = { commission: 'Commission', expense: 'Dépense', builder: 'Builder', manager: 'Manager' };
            if (filtered.length === 0) {
                wrap.innerHTML = `<p style="color: #94a3b8; padding: 24px;">${t('alerts.noTransactions')}</p>`;
                return;
            }
            wrap.innerHTML = `
                <table class="analyst-table">
                    <thead>
                        <tr><th>Date</th><th>Type</th><th>Libellé</th><th>Montant</th></tr>
                    </thead>
                    <tbody>
                        ${filtered.map(t => {
                            const isPos = t.amount >= 0;
                            const sym = t.currency === 'USD' ? '$' : '€';
                            const amountStr = (isPos ? '+' : '') + Number(t.amount).toFixed(2) + ' ' + sym;
                            return `<tr>
                                <td>${formatDate(t.date)}</td>
                                <td><span class="transaction-type-badge ${t.type}">${typeLabels[t.type] || t.type}</span></td>
                                <td>${t.label}${t.clientName ? ` <span style="color:#64748b;font-size:12px;">(${t.clientName})</span>` : ''}</td>
                                <td class="transaction-amount ${isPos ? 'positive' : 'negative'}">${amountStr}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            `;
        }
        
        function refreshAnalyst() {
            const kpiContainer = document.getElementById('analystKpis');
            if (!kpiContainer) return;

            const commissions = getCommissions();
            const agents = getAgents();
            
            let totalCA = 0;
            let totalLuscianaTax = 0;
            let totalTeamNet = 0;
            const byAgent = {};
            const byMonth = {};
            
            commissions.forEach(c => {
                const finished = isCommissionFinished(c);
                const amountForAnalyst = getCommissionAmountForAnalyst(c);
                totalCA += amountForAnalyst;
                
                if (finished && c.priceDistribution) {
                    let luscianaTax = 0;
                    let teamNet = 0;
                    Object.keys(c.priceDistribution).forEach(agentPseudo => {
                        const d = c.priceDistribution[agentPseudo];
                        const amount = Number(d?.price) || 0;
                        const percent = Number(d?.percent) || 0;
                        const tax = amount * (percent / 100);
                        const net = amount * (1 - percent / 100);
                        luscianaTax += tax;
                        teamNet += net;
                        byAgent[agentPseudo] = (byAgent[agentPseudo] || 0) + net;
                    });
                    totalLuscianaTax += luscianaTax;
                    totalTeamNet += teamNet;
                }
                
                const dateStr = c.buildEnd || c.buildStart || c.createdAt;
                if (dateStr && amountForAnalyst > 0) {
                    const d = new Date(dateStr);
                    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                    byMonth[key] = (byMonth[key] || 0) + amountForAnalyst;
                }
            });
            
            const expenses = getExpenses();
            let totalExpensesEUR = 0;
            let totalExpensesUSD = 0;
            expenses.forEach(e => {
                if (e.currency === 'USD') totalExpensesUSD += Number(e.amount) || 0;
                else totalExpensesEUR += Number(e.amount) || 0;
            });
            
            let expensesKpi = '';
            if (totalExpensesEUR > 0 || totalExpensesUSD > 0) {
                const parts = [];
                if (totalExpensesEUR > 0) parts.push(`${totalExpensesEUR.toFixed(2)} €`);
                if (totalExpensesUSD > 0) parts.push(`${totalExpensesUSD.toFixed(2)} $`);
                expensesKpi = `
                <div class="analyst-kpi-card outflow">
                    <h4>Dépenses</h4>
                    <div class="value">${parts.join(' · ')}</div>
                </div>`;
            }
            kpiContainer.innerHTML = `
                <div class="analyst-kpi-card">
                    <h4>Rentrées (CA total)</h4>
                    <div class="value">${totalCA.toFixed(2)} €</div>
                    <p style="font-size: 11px; color: #64748b; margin-top: 4px;">En cours = acompte uniquement</p>
                </div>
                <div class="analyst-kpi-card lusciana">
                    <h4>Taxe Lusciana</h4>
                    <div class="value">${totalLuscianaTax.toFixed(2)} €</div>
                </div>
                <div class="analyst-kpi-card team">
                    <h4>Part team (builders/managers)</h4>
                    <div class="value">${totalTeamNet.toFixed(2)} €</div>
                </div>
                ${expensesKpi}
            `;
            
            const expenseDateEl = document.getElementById('expenseDate');
            if (expenseDateEl && !expenseDateEl.value) {
                expenseDateEl.value = new Date().toISOString().slice(0, 10);
            }
            const expensesListEl = document.getElementById('analystExpensesList');
            if (expensesListEl) {
                if (expenses.length === 0) {
                    expensesListEl.innerHTML = `<p style="color: #94a3b8; font-size: 14px;">${t('alerts.noExpenses')}</p>`;
                } else {
                    const formatExpenseDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
                    expensesListEl.innerHTML = `
                        <table class="analyst-table">
                            <thead><tr><th>Date</th><th>Libellé</th><th>Montant</th><th></th></tr></thead>
                            <tbody>
                                ${expenses.map(e => `
                                    <tr>
                                        <td>${formatExpenseDate(e.date)}</td>
                                        <td>${e.label}</td>
                                        <td><strong>${Number(e.amount).toFixed(2)} ${e.currency === 'USD' ? '$' : '€'}</strong></td>
                                        <td>${canEditUi() ? `<button type="button" onclick="deleteExpense('${e.id}')" class="danger" style="padding: 6px 12px; font-size: 12px;">🗑️</button>` : ''}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    `;
                }
            }
            
            const monthLabels = Object.keys(byMonth).sort();
            const monthValues = monthLabels.map(k => byMonth[k]);
            const monthNames = monthLabels.map(k => {
                const [y, m] = k.split('-');
                const d = new Date(parseInt(y), parseInt(m) - 1);
                return d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
            });
            
            if (analystChartMonthly) analystChartMonthly.destroy();
            const ctxMonthly = document.getElementById('analystChartMonthly');
            if (ctxMonthly && typeof Chart !== 'undefined') {
                analystChartMonthly = new Chart(ctxMonthly, {
                    type: 'bar',
                    data: {
                        labels: monthNames.length ? monthNames : ['Aucune donnée'],
                        datasets: [{
                            label: 'CA (€)',
                            data: monthValues.length ? monthValues : [0],
                            backgroundColor: 'rgba(102, 126, 234, 0.7)',
                            borderColor: 'rgba(102, 126, 234, 1)',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                            y: { beginAtZero: true, ticks: { callback: v => v + ' €' } }
                        }
                    }
                });
            }
            
            const agentNames = Object.keys(byAgent).sort((a, b) => (byAgent[b] || 0) - (byAgent[a] || 0));
            const agentAmounts = agentNames.map(a => byAgent[a]);
            
            if (analystChartByAgent) analystChartByAgent.destroy();
            const ctxAgent = document.getElementById('analystChartByAgent');
            if (ctxAgent && typeof Chart !== 'undefined') {
                analystChartByAgent = new Chart(ctxAgent, {
                    type: 'bar',
                    data: {
                        labels: agentNames.length ? agentNames : ['Aucun'],
                        datasets: [{
                            label: 'CA net (€)',
                            data: agentAmounts.length ? agentAmounts : [0],
                            backgroundColor: 'rgba(16, 185, 129, 0.7)',
                            borderColor: 'rgba(16, 185, 129, 1)',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        indexAxis: 'y',
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                            x: { beginAtZero: true, ticks: { callback: v => v + ' €' } }
                        }
                    }
                });
            }
            
            const builderManagers = agents.filter(a => a.category === 'manager' || a.category === 'builder' || a.category === 'apprentice');
            const tableRows = builderManagers
                .map(a => {
                    const net = byAgent[a.pseudo] || 0;
                    return { pseudo: a.pseudo, category: a.category, net };
                })
                .sort((a, b) => b.net - a.net);
            
            const tableWrap = document.getElementById('analystTableWrap');
            tableWrap.innerHTML = `
                <table class="analyst-table">
                    <thead>
                        <tr><th>Agent</th><th>Catégorie</th><th>CA net (€)</th></tr>
                    </thead>
                    <tbody>
                        ${tableRows.length ? tableRows.map(r => `
                            <tr>
                                <td>${r.pseudo}</td>
                                <td><span class="badge ${r.category}">${getRoleLabel(r.category)}</span></td>
                                <td><strong>${r.net.toFixed(2)} €</strong></td>
                            </tr>
                        `).join('') : '<tr><td colspan="3">Aucun builder/manager ou aucune commission.</td></tr>'}
                    </tbody>
                </table>
            `;
            
            buildAllTransactions();
            renderTransactionsList();
        }
        
        function exportData() {
            const data = {
                agents: getAgents(),
                commissions: getCommissions(),
                expenses: getExpenses(),
                todos: getTodos(),
                exportDate: new Date().toISOString()
            };
            
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `lusciana_backup_${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            alert('Données exportées avec succès !');
        }
        
        function exportAgents() {
            const data = {
                agents: getAgents(),
                exportDate: new Date().toISOString()
            };
            
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `lusciana_agents_${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            alert('Agents exportés avec succès !');
        }
        
        function exportCommissions() {
            const data = {
                commissions: getCommissions(),
                exportDate: new Date().toISOString()
            };
            
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `lusciana_commissions_${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            alert('Commissions exportées avec succès !');
        }
        
        async function importData() {
            if (!requirePermission(canManageDangerousData, 'Seuls les administrateurs et plus peuvent importer des données.')) {
                return;
            }

            const fileInput = document.getElementById('importFile');
            const file = fileInput.files[0];
            
            if (!file) {
                alert('Veuillez sélectionner un fichier JSON');
                return;
            }
            
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const data = JSON.parse(e.target.result);
                    
                    if (confirm('Voulez-vous remplacer toutes les données existantes par celles du fichier ?')) {
                        await clearAllData(true);

                        if (Array.isArray(data.agents)) {
                            for (const agent of data.agents) {
                                await apiRequest('/agents', {
                                    method: 'POST',
                                    body: agent
                                });
                            }
                        }
                        if (Array.isArray(data.commissions)) {
                            for (const commission of data.commissions) {
                                await apiRequest('/commissions', {
                                    method: 'POST',
                                    body: commission
                                });
                            }
                        }
                        if (Array.isArray(data.expenses)) {
                            for (const expense of data.expenses) {
                                await apiRequest('/expenses', {
                                    method: 'POST',
                                    body: expense
                                });
                            }
                        }
                        if (Array.isArray(data.todos)) {
                            for (const todo of data.todos) {
                                await apiRequest('/todos', {
                                    method: 'POST',
                                    body: {
                                        title: todo.title,
                                        description: todo.description || '',
                                        status: todo.status || 'todo',
                                        deadline: todo.deadline || '',
                                        assignedTo: todo.assignedTo || ''
                                    }
                                });
                            }
                        }

                        await loadRemoteData();
                        
                        alert('Données importées avec succès !');
                    }
                } catch (error) {
                    alert('Erreur lors de l\'import : ' + error.message);
                }
            };
            reader.readAsText(file);
        }
        
        async function clearAllData(skipConfirmation = false) {
            if (!skipConfirmation && !requirePermission(canManageDangerousData, 'Seuls les administrateurs et plus peuvent supprimer toutes les données.')) {
                return;
            }

            if (!skipConfirmation && !confirm('⚠️ Êtes-vous sûr de vouloir supprimer TOUTES les données ? Cette action est irréversible !')) {
                return;
            }
            if (!skipConfirmation && !confirm('Dernière confirmation : supprimer toutes les données ?')) {
                return;
            }

            try {
                for (const commission of [...getCommissions()]) {
                    await apiRequest(`/commissions/${commission.id}`, { method: 'DELETE' });
                }
                for (const expense of [...getExpenses()]) {
                    await apiRequest(`/expenses/${expense.id}`, { method: 'DELETE' });
                }
                for (const agent of [...getAgents()]) {
                    await apiRequest(`/agents/${agent.id}`, { method: 'DELETE' });
                }
                for (const todo of [...getTodos()]) {
                    await apiRequest(`/todos/${todo.id}`, { method: 'DELETE' });
                }

                agentsCache = [];
                commissionsCache = [];
                expensesCache = [];
                todosCache = [];
                clearSessionRemoteDataCache();
                
                loadAgentsIntoSelects();
                loadAgentsIntoSelector();
                loadAgentsIntoUserSelector();
                updateDataStats();
                displayCommissions();
                displayAgents();
                displayTodos();
                refreshAnalyst();

                if (!skipConfirmation) {
                    alert('Toutes les données ont été supprimées.');
                }
            } catch (error) {
                alert('Impossible de supprimer toutes les données : ' + error.message);
            }
        }
        
        
        // Génération de la liste des versions Minecraft
        function loadMinecraftVersions() {
            const versionSelect = document.getElementById('version');
            if (!versionSelect) return;
            const versions = [];
            
            // Liste complète des versions Minecraft de 1.6.4 à 1.21.11
            // 1.6.x
            versions.push('1.6.4');
            
            // 1.7.x
            versions.push('1.7.2', '1.7.4', '1.7.5', '1.7.6', '1.7.7', '1.7.8', '1.7.9', '1.7.10');
            
            // 1.8.x
            versions.push('1.8', '1.8.1', '1.8.2', '1.8.3', '1.8.4', '1.8.5', '1.8.6', '1.8.7', '1.8.8', '1.8.9');
            
            // 1.9.x
            versions.push('1.9', '1.9.1', '1.9.2', '1.9.3', '1.9.4');
            
            // 1.10.x
            versions.push('1.10', '1.10.1', '1.10.2');
            
            // 1.11.x
            versions.push('1.11', '1.11.1', '1.11.2');
            
            // 1.12.x
            versions.push('1.12', '1.12.1', '1.12.2');
            
            // 1.13.x
            versions.push('1.13', '1.13.1', '1.13.2');
            
            // 1.14.x
            versions.push('1.14', '1.14.1', '1.14.2', '1.14.3', '1.14.4');
            
            // 1.15.x
            versions.push('1.15', '1.15.1', '1.15.2');
            
            // 1.16.x
            versions.push('1.16', '1.16.1', '1.16.2', '1.16.3', '1.16.4', '1.16.5');
            
            // 1.17.x
            versions.push('1.17', '1.17.1');
            
            // 1.18.x
            versions.push('1.18', '1.18.1', '1.18.2');
            
            // 1.19.x
            versions.push('1.19', '1.19.1', '1.19.2', '1.19.3', '1.19.4');
            
            // 1.20.x
            versions.push('1.20', '1.20.1', '1.20.2', '1.20.3', '1.20.4', '1.20.5', '1.20.6');
            
            // 1.21.x
            versions.push('1.21', '1.21.1', '1.21.2', '1.21.3', '1.21.4', '1.21.5', '1.21.6', '1.21.7', '1.21.8', '1.21.9', '1.21.10', '1.21.11');
            
            versions.forEach(version => {
                const option = new Option(version, version);
                versionSelect.add(option);
            });
        }
        
        // Mettre à jour la répartition quand le % commission change
        function runWhenDomReady(fn) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', fn);
            } else {
                fn();
            }
        }

        runWhenDomReady(function() {
            bindSessionActivityListeners();
            void tryRestoreAuthSession();
            window.addEventListener('hashchange', function() {
                applyTabFromHash();
            });
            const commissionInput = document.getElementById('commissionPercent');
            if (commissionInput) {
                commissionInput.addEventListener('input', updateWhoTookWhat);
                commissionInput.addEventListener('input', updateTotalAmount);
            }
        });
        
        // Initialisation (données chargées après connexion Google dans showApp)
        loadMinecraftVersions();
