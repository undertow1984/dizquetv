module.exports = function (dizquetv, $timeout) {
    return {
        restrict: 'E',
        templateUrl: 'templates/trakt-settings.html',
        replace: true,
        scope: {},
        link: function (scope) {
            scope.settings = { traktClientId: '' };
            scope.status = '';
            scope.error = '';
            scope.saving = false;

            function load() {
                dizquetv.getExternalListSettings().then((s) => {
                    scope.settings = {
                        traktClientId: (s && s.traktClientId) || '',
                    };
                    $timeout();
                }).catch((err) => {
                    console.error(err);
                    scope.error = 'Failed to load Trakt settings.';
                    $timeout();
                });
            }

            scope.updateSettings = () => {
                scope.saving = true;
                scope.error = '';
                scope.status = '';
                dizquetv.updateExternalListSettings({
                    traktClientId: (scope.settings.traktClientId || '').trim(),
                }).then((s) => {
                    scope.settings.traktClientId = (s && s.traktClientId) || '';
                    scope.status = 'Trakt settings saved.';
                    scope.saving = false;
                    $timeout();
                    $timeout(() => { scope.status = ''; $timeout(); }, 3000);
                }).catch((err) => {
                    console.error(err);
                    scope.error = 'Failed to save Trakt settings.';
                    scope.saving = false;
                    $timeout();
                });
            };

            load();
        },
    };
};
