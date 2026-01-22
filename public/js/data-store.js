/**
 * Data Store
 * Holds Accounts, Models, and Computed Quota Rows
 * Shared between Dashboard and AccountManager
 */

// utils is loaded globally as window.utils in utils.js

document.addEventListener('alpine:init', () => {
    Alpine.store('data', {
        accounts: [],
        models: [], // Source of truth
        modelConfig: {}, // Model metadata (hidden, pinned, alias)
        quotaRows: [], // Filtered view
        usageHistory: {}, // Usage statistics history (from /account-limits?includeHistory=true)
        maxAccounts: 10, // Maximum number of accounts allowed (from config)
        loading: false,
        initialLoad: true, // Track first load for skeleton screen
        connectionStatus: 'connecting',
        lastUpdated: '-',
        healthCheckTimer: null,

        // Filters state
        filters: {
            account: 'all',
            family: 'all',
            search: '',
            sortCol: 'avgQuota',
            sortAsc: true
        },

        // Settings for calculation
        // We need to access global settings? Or duplicate?
        // Let's assume settings are passed or in another store.
        // For simplicity, let's keep relevant filters here.

        init() {
            // Restore from cache first for instant render
            this.loadFromCache();

            // Watch filters to recompute
            // Alpine stores don't have $watch automatically unless inside a component?
            // We can manually call compute when filters change.

            // Start health check monitoring
            this.startHealthCheck();
        },

        loadFromCache() {
            try {
                const cached = localStorage.getItem('ag_data_cache');
                if (cached) {
                    const data = JSON.parse(cached);
                    const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

                    // Check TTL
                    if (data.timestamp && Date.now() - data.timestamp > CACHE_TTL) {
                        console.log('Cache expired, skipping restoration');
                        localStorage.removeItem('ag_data_cache');
                        return;
                    }

                    // Basic validity check
                    if (data.accounts && data.models) {
                        this.accounts = data.accounts;
                        this.models = data.models;
                        this.modelConfig = data.modelConfig || {};
                        this.usageHistory = data.usageHistory || {};

                        // Don't show loading on initial load if we have cache
                        this.initialLoad = false;
                        this.computeQuotaRows();
                        console.log('Restored data from cache');
                    }
                }
            } catch (e) {
                console.warn('Failed to load cache', e);
            }
        },

        saveToCache() {
            try {
                const cacheData = {
                    accounts: this.accounts,
                    models: this.models,
                    modelConfig: this.modelConfig,
                    usageHistory: this.usageHistory,
                    timestamp: Date.now()
                };
                localStorage.setItem('ag_data_cache', JSON.stringify(cacheData));
            } catch (e) {
                console.warn('Failed to save cache', e);
            }
        },

        async fetchData() {
            // Only show skeleton on initial load if we didn't restore from cache
            if (this.initialLoad) {
                this.loading = true;
            }
            try {
                // Get password from global store
                const password = Alpine.store('global').webuiPassword;

                // Include history for dashboard (single API call optimization)
                const url = '/account-limits?includeHistory=true';
                const { response, newPassword } = await window.utils.request(url, {}, password);

                if (newPassword) Alpine.store('global').webuiPassword = newPassword;

                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const data = await response.json();
                this.accounts = data.accounts || [];
                if (data.models && data.models.length > 0) {
                    this.models = data.models;
                }
                this.modelConfig = data.modelConfig || {};

                // Store usage history if included (for dashboard)
                if (data.history) {
                    this.usageHistory = data.history;
                }

                this.saveToCache(); // Save fresh data
                this.computeQuotaRows();

                this.lastUpdated = new Date().toLocaleTimeString();
            } catch (error) {
                console.error('Fetch error:', error);
                const store = Alpine.store('global');
                store.showToast(store.t('connectionLost'), 'error');
            } finally {
                this.loading = false;
                this.initialLoad = false; // Mark initial load as complete
            }
        },

        async performHealthCheck() {
            try {
                // Get password from global store
                const password = Alpine.store('global').webuiPassword;

                // Use lightweight endpoint (no quota fetching)
                const { response, newPassword } = await window.utils.request(
                    '/api/config',
                    {},
                    password
                );

                if (newPassword) Alpine.store('global').webuiPassword = newPassword;

                if (response.ok) {
                    this.connectionStatus = 'connected';
                } else {
                    this.connectionStatus = 'disconnected';
                }
            } catch (error) {
                console.error('Health check error:', error);
                this.connectionStatus = 'disconnected';
            }
        },

        startHealthCheck() {
            // Clear existing timer
            if (this.healthCheckTimer) {
                clearInterval(this.healthCheckTimer);
            }

            // Setup visibility change listener (only once)
            if (!this._healthVisibilitySetup) {
                this._healthVisibilitySetup = true;
                this._visibilityHandler = () => {
                    if (document.hidden) {
                        // Tab hidden - stop health checks / close SSE
                        this.disconnectSSE();
                    } else {
                        // Tab visible - restart health checks / connect SSE
                        this.connectSSE();
                    }
                };
                document.addEventListener('visibilitychange', this._visibilityHandler);
            }

            // Start SSE connection
            this.connectSSE();
        },

        stopHealthCheck() {
            this.disconnectSSE();
        },

        connectSSE() {
            if (this.sseSource) return;

            // Connect to SSE stream
            // Include history to match initial fetch behavior logic if needed,
            // though usually history is fetched once. The stream provides status updates.
            this.sseSource = new EventSource('/api/accounts/stream');

            this.sseSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                this.handleServerUpdate(data);
                this.connectionStatus = 'connected';
            };

            this.sseSource.onerror = () => {
                this.connectionStatus = 'disconnected';
                // EventSource auto-reconnects, but we can track state here
                // If it fails permanently, we might want to manually retry or fallback
            };

            this.connectionStatus = 'connecting';
        },

        disconnectSSE() {
            if (this.sseSource) {
                this.sseSource.close();
                this.sseSource = null;
            }
        },

        handleServerUpdate(statusData) {
            // Merge status data into local accounts
            // statusData structure matches accountManager.getStatus()

            // Map accounts by email for easy lookup
            const statusMap = new Map(statusData.accounts.map((a) => [a.email, a]));

            // Update existing accounts in place to preserve object references where possible
            // or replace if structure differs significantly.
            // Since we use Alpine, reactivity is key.

            // Note: The SSE status data currently is metadata + limits relative to "getStatus()"
            // It might NOT include the deep quota info that "getQuotaRows" needs (from /account-limits).
            // However, implementation_plan says we should use SSE.
            // If getStatus() doesn't have deep quota info, we might still need to fetch details,
            // OR we update AccountManager to include everything in getStatus().
            // Looking at AccountManager.getStatus implementation:
            // It includes: source, enabled, projectId, modelRateLimits, isInvalid, invalidReason.
            // It does NOT include detailed per-model remaining percentages (fetched via API calls in /account-limits).

            // Critical decision:
            // 1. Fetch /account-limits on every SSE update (triggered by SSE).
            // 2. Or assume SSE update is enough for "status" (green/red) but not "quota %".

            // Given the goal is "Real-time account updates", we want everything.
            // But fetching /account-limits constantly is heavy.
            // Let's trigger a lightweight fetch or just update the metadata for now,
            // and maybe debounce a full fetch.

            // Actually, for "efficiency", replacing polling with "poll on event" is still better than "poll every X".
            // So if an event comes, we fetch fresh data.
            // Even better: if the event contained the data.
            // But calculating detailed quotas requires API calls to Google (slow).
            // accounts.json updates (from saveToDisk) happen on rate limits.

            // Strategy:
            // 1. Update metadata (enabled/disabled/rate-limited status) immediately from event.
            // 2. Trigger a debounced background fetch of full quotas if something significant changed.

            // Update metadata
            this.accounts.forEach((acc) => {
                const update = statusMap.get(acc.email);
                if (update) {
                    acc.enabled = update.enabled;
                    acc.isInvalid = update.isInvalid;
                    acc.invalidReason = update.invalidReason;
                    acc.modelRateLimits = update.modelRateLimits;
                    // If we have subscription data in event, update it
                    if (update.subscription) acc.subscription = update.subscription;
                }
            });

            // Calculate computed rows (visibility, etc) based on metadata
            this.computeQuotaRows();

            this.lastUpdated = new Date().toLocaleTimeString();
        },

        computeQuotaRows() {
            const models = this.models || [];
            const rows = [];
            const showExhausted = Alpine.store('settings')?.showExhausted ?? true;

            models.forEach((modelId) => {
                // Config
                const config = this.modelConfig[modelId] || {};
                const family = this.getModelFamily(modelId);

                // Visibility Logic for Models Page (quotaRows):
                // 1. If explicitly hidden via config, ALWAYS hide (clean interface)
                // 2. If no config, default 'unknown' families to HIDDEN
                // 3. Known families (Claude/Gemini) default to VISIBLE
                // Note: To manage hidden models, use Settings → Models tab
                let isHidden = config.hidden;
                if (isHidden === undefined) {
                    isHidden = family === 'other' || family === 'unknown';
                }

                // Models Page: Check settings for visibility
                const showHidden = Alpine.store('settings')?.showHiddenModels ?? false;
                if (isHidden && !showHidden) return;

                // Filters
                if (this.filters.family !== 'all' && this.filters.family !== family) return;
                if (this.filters.search) {
                    const searchLower = this.filters.search.toLowerCase();
                    const idMatch = modelId.toLowerCase().includes(searchLower);
                    if (!idMatch) return;
                }

                // Data Collection
                const quotaInfo = [];
                let minQuota = 100;
                let totalQuotaSum = 0;
                let validAccountCount = 0;
                let minResetTime = null;

                this.accounts.forEach((acc) => {
                    if (this.filters.account !== 'all' && acc.email !== this.filters.account)
                        return;

                    const limit = acc.limits?.[modelId];
                    if (!limit) return;

                    const pct =
                        limit.remainingFraction !== null
                            ? Math.round(limit.remainingFraction * 100)
                            : 0;
                    minQuota = Math.min(minQuota, pct);

                    // Accumulate for average
                    totalQuotaSum += pct;
                    validAccountCount++;

                    if (
                        limit.resetTime &&
                        (!minResetTime || new Date(limit.resetTime) < new Date(minResetTime))
                    ) {
                        minResetTime = limit.resetTime;
                    }

                    quotaInfo.push({
                        email: acc.email.split('@')[0],
                        fullEmail: acc.email,
                        pct: pct,
                        resetTime: limit.resetTime
                    });
                });

                if (quotaInfo.length === 0) return;
                const avgQuota =
                    validAccountCount > 0 ? Math.round(totalQuotaSum / validAccountCount) : 0;

                if (!showExhausted && minQuota === 0) return;

                rows.push({
                    modelId,
                    displayName: modelId, // Simplified: no longer using alias
                    family,
                    minQuota,
                    avgQuota, // Added Average Quota
                    minResetTime,
                    resetIn: minResetTime ? window.utils.formatTimeUntil(minResetTime) : '-',
                    quotaInfo,
                    pinned: !!config.pinned,
                    hidden: !!isHidden, // Use computed visibility
                    activeCount: quotaInfo.filter((q) => q.pct > 0).length
                });
            });

            // Sort: Pinned first, then by selected column
            const sortCol = this.filters.sortCol;
            const sortAsc = this.filters.sortAsc;

            this.quotaRows = rows.sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

                let valA = a[sortCol];
                let valB = b[sortCol];

                // Handle nulls (always push to bottom)
                if (valA === valB) return 0;
                if (valA === null || valA === undefined) return 1;
                if (valB === null || valB === undefined) return -1;

                if (typeof valA === 'string' && typeof valB === 'string') {
                    return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
                }

                return sortAsc ? valA - valB : valB - valA;
            });

            // Trigger Dashboard Update if active
            // Ideally dashboard watches this store.
        },

        setSort(col) {
            if (this.filters.sortCol === col) {
                this.filters.sortAsc = !this.filters.sortAsc;
            } else {
                this.filters.sortCol = col;
                // Default sort direction: Descending for numbers/stats, Ascending for text/time
                if (['avgQuota', 'activeCount'].includes(col)) {
                    this.filters.sortAsc = false;
                } else {
                    this.filters.sortAsc = true;
                }
            }
            this.computeQuotaRows();
        },

        getModelFamily(modelId) {
            const lower = modelId.toLowerCase();
            if (lower.includes('claude')) return 'claude';
            if (lower.includes('gemini')) return 'gemini';
            return 'other';
        },

        /**
         * Get quota data without filters applied (for Dashboard global charts)
         * Returns array of { modelId, family, quotaInfo: [{pct}] }
         */
        getUnfilteredQuotaData() {
            const models = this.models || [];
            const rows = [];
            const showHidden = Alpine.store('settings')?.showHiddenModels ?? false;

            models.forEach((modelId) => {
                const config = this.modelConfig[modelId] || {};
                const family = this.getModelFamily(modelId);

                // Smart visibility (same logic as computeQuotaRows)
                let isHidden = config.hidden;
                if (isHidden === undefined) {
                    isHidden = family === 'other' || family === 'unknown';
                }
                if (isHidden && !showHidden) return;

                const quotaInfo = [];
                // Use ALL accounts (no account filter)
                this.accounts.forEach((acc) => {
                    const limit = acc.limits?.[modelId];
                    if (!limit) return;
                    const pct =
                        limit.remainingFraction !== null
                            ? Math.round(limit.remainingFraction * 100)
                            : 0;
                    quotaInfo.push({ pct });
                });

                // treat missing quotaInfo as 0%/unknown; still include row
                rows.push({ modelId, family, quotaInfo });
            });

            return rows;
        }
    });
});
