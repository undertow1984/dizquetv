module.exports = function (dizquetv, $timeout) {
    return {
        restrict: 'E',
        templateUrl: 'templates/imagemagick-settings.html',
        replace: true,
        scope: {},
        link: function (scope) {
            scope.settings = { magickPath: '' };
            scope.settingsError = '';
            scope.testStatus = '';
            scope.testError = '';
            scope.testPending = false;

            dizquetv.getImagemagickSettings().then((settings) => {
                scope.settings = settings || { magickPath: '' };
                if (typeof scope.settings.magickPath === 'undefined' || scope.settings.magickPath === null) {
                    scope.settings.magickPath = '';
                }
            }).catch((err) => {
                console.error(err);
                scope.settingsError = 'Unable to load ImageMagick settings.';
            });

            scope.updateSettings = (settings) => {
                delete scope.settingsError;
                scope.testStatus = '';
                scope.testError = '';
                dizquetv.updateImagemagickSettings(settings).then((_settings) => {
                    scope.settings = _settings;
                }).catch((err) => {
                    if (err && typeof err.data === 'string') {
                        scope.settingsError = err.data;
                    } else {
                        scope.settingsError = 'Failed to save ImageMagick settings.';
                    }
                });
            };

            scope.resetSettings = () => {
                delete scope.settingsError;
                scope.testStatus = '';
                scope.testError = '';
                dizquetv.resetImagemagickSettings(scope.settings).then((_settings) => {
                    scope.settings = _settings;
                }).catch((err) => {
                    console.error(err);
                    scope.settingsError = 'Failed to reset ImageMagick settings.';
                });
            };

            scope.testPath = async () => {
                if (scope.testPending) {
                    return;
                }
                scope.testPending = true;
                scope.testStatus = '';
                scope.testError = '';
                $timeout();
                try {
                    let result = await dizquetv.testImagemagickSettings({
                        magickPath: (scope.settings && scope.settings.magickPath) || '',
                    });
                    if (result && result.ok) {
                        scope.testStatus = 'OK: ' + (result.path || 'magick') +
                            (result.version ? (' — ' + result.version) : '');
                    } else {
                        scope.testError = (result && result.error) ? result.error : 'ImageMagick not found.';
                    }
                } catch (err) {
                    console.error(err);
                    scope.testError = 'Test request failed.';
                } finally {
                    scope.testPending = false;
                    $timeout();
                }
            };
        }
    };
};
