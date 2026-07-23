module.exports = function (dizquetv, $timeout) {
    return {
        restrict: 'E',
        templateUrl: 'templates/config-transfer.html',
        replace: true,
        scope: {},
        link: function (scope, element) {
            scope.exporting = false;
            scope.importing = false;
            scope.message = '';
            scope.error = '';
            scope.importConfirmOpen = false;
            scope.pendingFile = null;
            scope.lastBackupName = '';

            // Bind file input outside ng-model (File objects are not ng-model friendly)
            $timeout(function () {
                let input = element[0].querySelector('#configImportFile');
                if (input) {
                    input.addEventListener('change', function (ev) {
                        let file = ev.target.files && ev.target.files[0];
                        scope.$apply(function () {
                            scope.onImportFileSelected(file || null);
                        });
                    });
                }
            }, 0);

            scope.clearStatus = function () {
                scope.message = '';
                scope.error = '';
            };

            scope.exportConfig = function () {
                if (scope.exporting || scope.importing) {
                    return;
                }
                scope.clearStatus();
                scope.exporting = true;
                dizquetv.exportConfigZip()
                    .then(function () {
                        scope.message = 'Configuration exported. Check your downloads folder for the zip file.';
                    })
                    .catch(function (err) {
                        console.error(err);
                        let detail = '';
                        if (err && err.data) {
                            if (typeof err.data === 'string') {
                                detail = err.data;
                            } else {
                                detail = err.data.message || err.data.error || '';
                                if (err.data.error && err.data.message && err.data.error !== err.data.message) {
                                    detail = err.data.message + ' (' + err.data.error + ')';
                                }
                            }
                        } else if (err && err.message) {
                            detail = err.message;
                        } else if (err && err.status) {
                            detail = 'HTTP ' + err.status;
                        }
                        scope.error = detail ? ('Export failed: ' + detail) : 'Export failed.';
                    })
                    .finally(function () {
                        scope.exporting = false;
                        $timeout();
                    });
            };

            scope.onImportFileSelected = function (file) {
                scope.clearStatus();
                if (!file) {
                    return;
                }
                let name = (file.name || '').toLowerCase();
                if (name && name.indexOf('.zip') === -1) {
                    scope.error = 'Please choose a .zip configuration archive.';
                    $timeout();
                    return;
                }
                scope.pendingFile = file;
                scope.importConfirmOpen = true;
                $timeout();
            };

            scope.cancelImport = function () {
                scope.importConfirmOpen = false;
                scope.pendingFile = null;
                // reset file input
                let input = document.getElementById('configImportFile');
                if (input) {
                    input.value = '';
                }
                $timeout();
            };

            scope.confirmImport = function () {
                if (!scope.pendingFile || scope.importing) {
                    return;
                }
                scope.importing = true;
                scope.clearStatus();
                dizquetv.importConfigZip(scope.pendingFile)
                    .then(function (result) {
                        scope.importConfirmOpen = false;
                        scope.pendingFile = null;
                        scope.lastBackupName = (result && result.backupFilename) || '';
                        scope.message =
                            (result && result.message) ||
                            'Configuration imported. Reloading…';
                        $timeout();
                        // Full page reload so channels/settings reflect the new files
                        $timeout(function () {
                            window.location.reload();
                        }, 1200);
                    })
                    .catch(function (err) {
                        console.error(err);
                        scope.error =
                            (err && err.data && (err.data.message || err.data.error)) ||
                            (err && err.message) ||
                            'Import failed.';
                        scope.importing = false;
                        $timeout();
                    });
            };
        }
    };
};
