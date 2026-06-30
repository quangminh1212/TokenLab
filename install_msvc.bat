@echo off
echo ========================================
echo Installing MSVC C++ Build Tools
echo ========================================
echo.
echo Opening Visual Studio Installer...
echo Please check "Desktop development with C++" and click Modify.
echo.
"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe" modify --installPath "C:\Program Files\Microsoft Visual Studio\2022\Community" --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100
