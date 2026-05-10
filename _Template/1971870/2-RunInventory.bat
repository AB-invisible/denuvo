
@echo off

echo IF YOU GET INVALID DIRECTORY ERROR IN NEXT STEPS, MOVE GAME OUT OF PROGRAM FILES!!!
echo ...or run this batch script as administrator at your own risk.
echo ----------------------------------------------------------------------------------------------------------
echo In case you get "Directory not found" error, it means that you didn't run 1-Install_MK1InventoryEmu.exe!
echo ----------------------------------------------------------------------------------------------------------
cd "%~dp0MK12\Binaries\Win64"
Start "" "MK1InvEmulator.exe"
pause