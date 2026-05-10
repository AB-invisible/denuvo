@echo off

echo ----------------------------------------------------------------------------------------------------------
echo Are you getting one of the following errors after running this?
echo - Directory not found
echo - The system cannot find the file MK1InvEmulator.exe
echo - MK1InvEmulator.exe is not a valid executable
echo - pwsh.exe is not a valid executable
echo ----------------------------------------------------------------------------------------------------------
echo If so then it means YOU DIDN'T READ THE INSTRUCTIONS AND DONE THINGS YOUR WAY. YOU WANT THE GAME TO WORK?
echo THEN FOLLOW THE INSTRUCTIONS AND LEARN TO READ WHILE AT IT!!!
echo ----------------------------------------------------------------------------------------------------------
echo Oh and by the way, you must run this everytime you wanna play MK1
echo ----------------------------------------------------------------------------------------------------------

cd "%~dp0MK12\Binaries\Win64"

Start "" "MK1InvEmulator.exe"

pause