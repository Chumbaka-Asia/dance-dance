@echo off
cd /d "%~dp0"
echo.
echo  Starting Dance-Dance hub server...
echo.
echo  Open http://localhost:9000/dance-dance.html in your browser to see the floor.
echo  Share http://YOUR_IP:9000/upload.html with phones (find YOUR_IP with ipconfig).
echo  Press Ctrl+C here to stop the server.
echo.
python scripts\server.py
