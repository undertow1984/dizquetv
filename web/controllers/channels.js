module.exports = function ($scope, dizquetv) {
    $scope.channels = []
    $scope.showChannelConfig = false
    $scope.showBulkImport = false
    $scope.selectedChannel = null
    $scope.selectedChannelIndex = -1

    $scope.openBulkImport = () => {
        $scope.showChannelConfig = false
        $scope.showBulkImport = true
    }

    $scope.onBulkImportDone = (didImport) => {
        $scope.showBulkImport = false
        if (didImport) {
            $scope.refreshChannels()
        }
    }

    $scope.refreshChannels = async () => {
        $scope.channels = [ { number: 1, pending: true} ]
        let channelNumbers = await dizquetv.getChannelNumbers();
        $scope.channels = channelNumbers.map( (x) => {
            return {
                number: x,
                pending: true,
            }
        });
        $scope.$apply();
        $scope.queryChannels();
    }
    $scope.refreshChannels();

    $scope.queryChannels = () => {
        for (let i = 0; i < $scope.channels.length; i++) {
            $scope.queryChannel(i, $scope.channels[i] );
        }
    }

    $scope.queryChannel = async (index, channel) => {
        let ch = await dizquetv.getChannelDescription(channel.number);
        ch.pending = false;
        $scope.channels[index] = ch;
        $scope.$apply();
    }

    $scope.removeChannel = async ($index, channel) => {
        if (confirm("Are you sure to delete channel: " + channel.name + "?")) {
            $scope.channels[$index].pending = true;
            await dizquetv.removeChannel(channel);
            $scope.refreshChannels();
        }
    }
    $scope.onChannelConfigDone = async (channel) => {
        if ($scope.selectedChannelIndex != -1) {
            $scope.channels[ $scope.selectedChannelIndex ].pending = false;
        }
        if (typeof channel !== 'undefined') {
            if ($scope.selectedChannelIndex == -1) { // add new channel
                // Server generates dynamic PSD logo and returns channel with icon path
                await dizquetv.addChannel(channel);
                $scope.showChannelConfig = false
                $scope.refreshChannels();
            
            } else if (
                   (typeof($scope.originalChannelNumber) !== 'undefined')
                      && ($scope.originalChannelNumber != channel.number)
            ) {
                // update + change channel number (pass previous so tracked Lists stay linked)
                $scope.channels[ $scope.selectedChannelIndex ].pending = true;
                await dizquetv.updateChannel(channel, {
                    previousNumber: $scope.originalChannelNumber,
                });
                await dizquetv.removeChannel( { number: $scope.originalChannelNumber } )
                $scope.showChannelConfig = false
                $scope.$apply();
                $scope.refreshChannels();
            } else { // update existing channel
                $scope.channels[ $scope.selectedChannelIndex ].pending = true;
                // Response includes server-side dynamic logo path (do not keep client dizquetv.png)
                await dizquetv.updateChannel(channel, {
                    previousNumber: $scope.originalChannelNumber,
                });
                $scope.showChannelConfig = false
                $scope.$apply();
                $scope.refreshChannels();
            }
        } else {
            $scope.showChannelConfig = false
        }

        
    }
    $scope.selectChannel = async (index) => {
        if ( (index === -1) || $scope.channels[index].pending ) {
            $scope.originalChannelNumber = undefined;
            $scope.selectedChannel = null
            $scope.selectedChannelIndex = -1
            $scope.showChannelConfig = true
        } else {
            $scope.channels[index].pending = true;
            let p = await Promise.all([
                dizquetv.getChannelProgramless($scope.channels[index].number),
                dizquetv.getChannelPrograms($scope.channels[index].number),
            ]);
            let ch = p[0];
            ch.programs = p[1];
            let newObj = ch;
            newObj.startTime = new Date(newObj.startTime)
            $scope.originalChannelNumber = newObj.number;
            $scope.selectedChannel = newObj
            $scope.selectedChannelIndex = index
            $scope.showChannelConfig = true
            $scope.$apply();
        }
    }
}