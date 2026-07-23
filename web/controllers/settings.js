module.exports = function ($scope, $location) {
    $scope.selected = $location.hash()
    if ($scope.selected === '')
        $scope.selected = 'xmltv'
    // Keep hash in sync when switching tabs (deep links like /#!/settings#trakt)
    $scope.$watch('selected', function (v) {
        if (v && $location.hash() !== v) {
            $location.hash(v)
        }
    })
}