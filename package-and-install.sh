package_file="com.danvnest.applauncherandstatereporter_2.0.4_all.ipk"

sdk_version=$(ares-device -i | awk -F': ' '/sdkVersion/ {print $2}')
sdk_major_version=$(echo "$sdk_version" | cut -d. -f1)
if [ -z "$sdk_version" ]; then
    echo "Could not determine TV's SDK version via 'ares-device -i'"
    exit 1
fi
if [ "$sdk_major_version" -ge 7 ]; then
    echo "TV SDK version $sdk_version does not require the media state reporting service, packaging tv-app only"
    echo "> ares-package tv-app/\n"
    ares-package tv-app/ || exit 1
else
    if [ ! -f "tv-service-src/mqtt-config.json" ]; then
        echo "The 'tv-service-src/mqtt-config.json' file does not exist, copy the 'mqtt-config.example.json' template and adjust"
        exit 1
    fi

    service_changes=true
    checksum_file="tv-service-src/.last_checksum"
    if [ -f "$checksum_file" ]; then
        current_checksum=$(find tv-service-src -type f ! -name '.last_checksum' -exec md5sum {} + | sort | md5sum | awk '{print $1}') || exit 1
        last_checksum=$(cat "$checksum_file")
        if [ "$current_checksum" = "$last_checksum" ]; then
            service_changes=false
        fi
    fi
    echo "$current_checksum" >"$checksum_file" || exit 1

    if [ $service_changes = true ]; then
        echo "Compiling tv-service"
        cd tv-service-src || exit 1
        echo "> npm install && npm run build && cp package.json ../tv-service/ && cd ../tv-service && npm install --omit=dev"
        npm install || exit 1
        npm run build || exit 1
        cp package.json ../tv-service/ || exit 1
        cd ../tv-service && npm install --omit=dev || exit 1
        cd .. || exit 1
        echo "\n"
    fi

    echo "Packaging tv-app and tv-service"
    echo "> ares-package tv-app/ tv-service/\n"
    ares-package tv-app/ tv-service/ || exit 1
fi

timeout=5000
elapsed=0
while [ ! -e $package_file ] && [ $elapsed -lt $timeout ]; do
    sleep 0.1
    elapsed=$((elapsed + 100))
done
if [ ! -e $package_file ]; then
    echo "Could not install to TV as $package_file was not created"
    exit 1
fi

echo "\nInstalling on TV"
echo "> ares-install $package_file\n"
ares-install $package_file
