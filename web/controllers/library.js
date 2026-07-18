module.exports = function ($scope, $timeout, dizquetv, plex) {
    $scope.showManagement = false;
    $scope.managementLoading = false;
    $scope.managementSaving = false;
    $scope.managementError = "";
    $scope.managementStatus = "";
    $scope.managementLibraries = []; // { serverName, sectionKey, title, type, enabled }

    $scope.openManagement = () => {
        $scope.showManagement = true;
        $scope.loadManagementLibraries();
    };

    $scope.closeManagement = () => {
        $scope.showManagement = false;
        $scope.managementStatus = "";
        $scope.managementError = "";
    };

    $scope.loadManagementLibraries = async () => {
        $scope.managementLoading = true;
        $scope.managementError = "";
        $scope.managementStatus = "";
        $scope.managementLibraries = [];
        $timeout();
        try {
            let servers = await dizquetv.getPlexServers();
            if (!servers || servers.length === 0) {
                $scope.managementError = "No Plex servers configured. Add one under Settings.";
                return;
            }
            let settings = await dizquetv.getPlexLibrarySettings();
            let disabled = {};
            let list = (settings && settings.disabledLibraries) ? settings.disabledLibraries : [];
            for (let i = 0; i < list.length; i++) {
                if (list[i].serverName && list[i].sectionKey) {
                    disabled[list[i].serverName + "|" + list[i].sectionKey] = true;
                }
            }

            let rows = [];
            for (let s = 0; s < servers.length; s++) {
                let server = servers[s];
                try {
                    // includeDisabled so management always lists every library
                    let libs = await plex.getLibrary(server, { includeDisabled: true });
                    for (let i = 0; i < libs.length; i++) {
                        let lib = libs[i];
                        let id = server.name + "|" + lib.sectionKey;
                        rows.push({
                            serverName: server.name,
                            sectionKey: lib.sectionKey,
                            title: lib.title,
                            type: lib.type,
                            icon: lib.icon,
                            enabled: !disabled[id],
                        });
                    }
                } catch (err) {
                    console.error(err);
                    $scope.managementError =
                        ($scope.managementError ? $scope.managementError + " " : "") +
                        "Failed to load libraries from " + server.name + ".";
                }
            }
            rows.sort((a, b) => {
                let sa = (a.serverName + " " + a.title).toLowerCase();
                let sb = (b.serverName + " " + b.title).toLowerCase();
                if (sa < sb) return -1;
                if (sa > sb) return 1;
                return 0;
            });
            $scope.managementLibraries = rows;
        } catch (err) {
            console.error(err);
            $scope.managementError = "Unable to load library management data.";
        } finally {
            $scope.managementLoading = false;
            $timeout();
        }
    };

    $scope.toggleLibrary = async (lib) => {
        // ng-model already flipped enabled; persist immediately
        await $scope.saveManagementSettings();
    };

    $scope.enableAllLibraries = async () => {
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            $scope.managementLibraries[i].enabled = true;
        }
        await $scope.saveManagementSettings();
    };

    $scope.disableAllLibraries = async () => {
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            $scope.managementLibraries[i].enabled = false;
        }
        await $scope.saveManagementSettings();
    };

    $scope.saveManagementSettings = async () => {
        if ($scope.managementSaving) {
            return;
        }
        $scope.managementSaving = true;
        $scope.managementError = "";
        $timeout();
        try {
            let disabled = [];
            for (let i = 0; i < $scope.managementLibraries.length; i++) {
                let lib = $scope.managementLibraries[i];
                if (!lib.enabled) {
                    disabled.push({
                        serverName: lib.serverName,
                        sectionKey: String(lib.sectionKey),
                        title: lib.title,
                        type: lib.type,
                    });
                }
            }
            await dizquetv.updatePlexLibrarySettings({ disabledLibraries: disabled });
            if (typeof plex.clearLibrarySettingsCache === 'function') {
                plex.clearLibrarySettingsCache();
            }
            $scope.managementStatus =
                "Saved. " +
                ($scope.managementLibraries.length - disabled.length) +
                " enabled, " +
                disabled.length +
                " disabled.";
        } catch (err) {
            console.error(err);
            $scope.managementError = "Failed to save library settings.";
        } finally {
            $scope.managementSaving = false;
            $timeout();
        }
    };
};
