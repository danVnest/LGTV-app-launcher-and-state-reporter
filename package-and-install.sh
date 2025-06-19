echo "Compiling service"
cd tv-service || exit
npm install
npm run build
echo "Adding stuff"
npm run postbuild-linux
cd .. || exit

echo "Packaging"
ares-package tv-app/ tv-service/

echo "Installing"
ares-install com.com.danvnest.applauncher+mqtt_1.0.0_all.ipk -d TV
