module.exports = function (jellyfin, dizquetv, $timeout) {
    return {
        restrict: 'E',
        templateUrl: 'templates/jellyfin-settings.html',
        replace: true,
        scope: {},
        link: function (scope) {
            scope.serversPending = true;
            scope.serverError = '';
            scope.adding = false;
            scope.settings = null;
            scope.pathOptions = [
                { id: 'jellyfin', description: 'Network (Jellyfin HTTP stream)' },
                { id: 'direct', description: 'Direct (local file path)' },
            ];
            scope.newServer = {
                name: 'jellyfin',
                uri: 'http://127.0.0.1:8096',
                apiKey: '',
                userId: '',
            };
            scope._serverEditorState = { visible: false };

            scope.loadSettings = async () => {
                try {
                    scope.settings = await dizquetv.getJellyfinSettings();
                } catch (err) {
                    console.error(err);
                    scope.settings = {
                        streamPath: 'jellyfin',
                        pathReplace: '',
                        pathReplaceWith: '',
                    };
                }
                $timeout(() => { scope.$apply() }, 0);
            };
            scope.loadSettings();

            scope.updateSettings = (settings) => {
                dizquetv.updateJellyfinSettings(settings).then((_settings) => {
                    scope.settings = _settings;
                    $timeout(() => { scope.$apply() }, 0);
                }).catch((err) => {
                    console.error(err);
                    scope.serverError = 'Failed to save Jellyfin path settings.';
                    $timeout(() => { scope.$apply() }, 0);
                });
            };
            scope.resetSettings = (settings) => {
                dizquetv.resetJellyfinSettings(settings || {}).then((_settings) => {
                    scope.settings = _settings;
                    $timeout(() => { scope.$apply() }, 0);
                }).catch((err) => {
                    console.error(err);
                    scope.serverError = 'Failed to reset Jellyfin path settings.';
                    $timeout(() => { scope.$apply() }, 0);
                });
            };

            scope.refreshServerList = async () => {
                scope.serversPending = true;
                try {
                    let servers = await dizquetv.getJellyfinServers();
                    scope.servers = servers || [];
                    for (let i = 0; i < scope.servers.length; i++) {
                        scope.servers[i].uiStatus = 0;
                        scope.servers[i].backendStatus = 0;
                        let t = (new Date()).getTime();
                        scope.servers[i].uiPending = t;
                        scope.servers[i].backendPending = t;
                        scope.refreshUIStatus(t, i);
                        scope.refreshBackendStatus(t, i);
                    }
                } catch (err) {
                    console.error(err);
                    scope.serverError = 'Could not load Jellyfin servers.';
                } finally {
                    scope.serversPending = false;
                    $timeout(() => { scope.$apply() }, 0);
                }
            };
            scope.refreshServerList();

            scope.refreshUIStatus = async (t, i) => {
                try {
                    let s = await jellyfin.check(scope.servers[i]);
                    if (scope.servers[i].uiPending == t) {
                        scope.servers[i].uiStatus = s;
                    }
                } catch (e) {
                    if (scope.servers[i].uiPending == t) {
                        scope.servers[i].uiStatus = -1;
                    }
                }
                $timeout(() => { scope.$apply() }, 0);
            };

            scope.refreshBackendStatus = async (t, i) => {
                try {
                    let s = await dizquetv.checkExistingJellyfinServer(scope.servers[i].name);
                    if (scope.servers[i].backendPending == t) {
                        scope.servers[i].backendStatus = s.status;
                    }
                } catch (e) {
                    if (scope.servers[i].backendPending == t) {
                        scope.servers[i].backendStatus = -1;
                    }
                }
                $timeout(() => { scope.$apply() }, 0);
            };

            scope.editServer = (server) => {
                scope._serverEditorState = {
                    visible: true,
                    server: {
                        name: server.name,
                        uri: server.uri,
                        apiKey: server.apiKey || server.accessToken || '',
                        userId: server.userId || '',
                    },
                };
            };

            scope.serverEditFinished = () => {
                scope.refreshServerList();
            };

            scope.addServer = async () => {
                scope.serverError = '';
                scope.adding = true;
                try {
                    if (!scope.newServer.uri || !scope.newServer.apiKey) {
                        throw Error('URI and API key are required');
                    }
                    // Probe before saving
                    let status = await dizquetv.checkNewJellyfinServer(scope.newServer);
                    if (!status || status.status !== 1) {
                        throw Error('Could not reach Jellyfin with the given URI/API key');
                    }
                    await dizquetv.addJellyfinServer(scope.newServer);
                    scope.newServer = {
                        name: 'jellyfin',
                        uri: 'http://127.0.0.1:8096',
                        apiKey: '',
                        userId: '',
                    };
                    await scope.refreshServerList();
                } catch (err) {
                    console.error(err);
                    scope.serverError = err.message || 'Failed to add Jellyfin server';
                } finally {
                    scope.adding = false;
                    $timeout(() => { scope.$apply() }, 0);
                }
            };
        }
    };
};
