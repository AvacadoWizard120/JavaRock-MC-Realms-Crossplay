if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm install
npm run realm:probe
Read-Host "Press Enter to exit"
