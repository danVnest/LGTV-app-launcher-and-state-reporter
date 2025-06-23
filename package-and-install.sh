service_changes=true
checksum_file="tv-service-src/.last_checksum"
if [ ! -d tv-service ]; then
    mkdir tv-service
elif [ -f "$checksum_file" ]; then
    current_checksum=$(find tv-service-src -type f ! -name '.last_checksum' -exec md5sum {} + | sort | md5sum | awk '{print $1}') || exit
    last_checksum=$(cat "$checksum_file")
    if [ "$current_checksum" = "$last_checksum" ]; then
        service_changes=false
    fi
fi
echo "$current_checksum" >"$checksum_file" || exit

if [ $service_changes = true ]; then
    echo "Compiling tv-service"
    cd tv-service-src || exit
    echo "> npm install && npm run build && npm run postbuild"
    npm install || exit
    npm run build || exit
    npm run postbuild || exit
    cd .. || exit
    echo "\n"
fi

echo "Packaging tv-app and tv-service"
echo "> ares-package tv-app/ tv-service/\n"
ares-package tv-app/ tv-service/ || exit

package_file="com.danvnest.applauncher+mqtt_1.0.0_all.ipk"
timeout=5000
elapsed=0
while [ ! -e $package_file ] && [ $elapsed -lt $timeout ]; do
    sleep 0.1
    elapsed=$((elapsed + 100))
done
if [ ! -e $package_file ]; then
    echo "ERROR: $package_file was not created"
    exit
fi

echo "\nInstalling on TV"
echo "> ares-install $package_file -d TV\n"
ares-install $package_file -d TV
