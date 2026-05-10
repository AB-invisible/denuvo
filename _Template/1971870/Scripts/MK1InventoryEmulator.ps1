# Install_MK1InventoryEmu by github.com/MrRubberDucky for Pub's Lounge - v2.0.0 @ compiled to executable with ps2exe
# This utility is provided as-is, with no warranties or guarantees.

# Learning material:
# - https://stackoverflow.com/a/40889721 (YesNo checking)
# - https://stackoverflow.com/a/52856925 (Program installation checking)
# - https://til.juliusgamanyi.com/posts/prefer-webclient-for-downloads-not-invoke-webrequest/ (WebRequest issues)
# - https://stackoverflow.com/a/70470467 (Get-File)

function Get-File {
    param (
        [Parameter(Mandatory, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [System.Uri]
        $Uri,
        [Parameter(Mandatory, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [System.IO.FileInfo]
        $TargetFile,
        [Parameter(ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [Int32]
        $BufferSize = 1,
        [Parameter(ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [ValidateSet('KB, MB')]
        [String]
        $BufferUnit = 'MB',
        [Parameter(ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [ValidateSet('KB, MB')]
        [Int32]
        $Timeout = 10000
    )
    $useBitTransfer = $null -ne (Get-Module -Name BitsTransfer -ListAvailable) -and ($PSVersionTable.PSVersion.Major -le 5)
    if ($useBitTransfer)
    {
        Write-Information -MessageData 'Using a fallback BitTransfer method since you are running Windows PowerShell'
        Start-BitsTransfer -Source $Uri -Destination "$($TargetFile.FullName)"
    }
    else
    {
        $request = [System.Net.HttpWebRequest]::Create($Uri)
        $request.set_Timeout($Timeout) #15 second timeout
        $response = $request.GetResponse()
        $totalLength = [System.Math]::Floor($response.get_ContentLength() / 1024)
        $responseStream = $response.GetResponseStream()
        $targetStream = New-Object -TypeName ([System.IO.FileStream]) -ArgumentList "$($TargetFile.FullName)", Create
        switch ($BufferUnit)
        {
            'KB' { $BufferSize = $BufferSize * 1024 }
            'MB' { $BufferSize = $BufferSize * 1024 * 1024 }
            Default { $BufferSize = 1024 * 1024 }
        }
        Write-Verbose -Message "Buffer size: $BufferSize B ($($BufferSize/("1$BufferUnit")) $BufferUnit)"
        $buffer = New-Object byte[] $BufferSize
        $count = $responseStream.Read($buffer, 0, $buffer.length)
        $downloadedBytes = $count
        $downloadedFileName = $Uri -split '/' | Select-Object -Last 1
        Write-Host "Starting download for '$downloadedFileName'"
        while ($count -gt 0)
        {
            $targetStream.Write($buffer, 0, $count)
            $count = $responseStream.Read($buffer, 0, $buffer.length)
            $downloadedBytes = $downloadedBytes + $count
        }
        Write-Host "Finished downloading file '$downloadedFileName' to current directory." -BackgroundColor DarkGreen
        $targetStream.Flush()
        $targetStream.Close()
        $targetStream.Dispose()
        $responseStream.Dispose()
    }
}

# Initialize variables early
$ghApiURL = "https://api.github.com/repos/GhostyPool/MK1InvEmulator/releases/latest"
$ghDownloadURL = $(Invoke-RestMethod $ghApiURL).assets.browser_download_url | Where-Object {$_.EndsWith(".7z")}

# Now we begin!
Write-Host "Script made for discord.gg/pubslounge | Source Code & Author: github.com/mrrubberducky" -BackgroundColor DarkGreen

# Download 7zip console utility from official site
if (-not(Test-Path -path "$pwd\7zr.exe")) {
    try {
        Get-File "https://www.7-zip.org/a/7zr.exe" ".\7zr.exe"
    } catch {
        Write-Host "MOVE GAME FOLDER OUT OF PROGRAM FILES! It's a PROTECTED directory."
        Write-Host "If you want to ignore this warning, run this script as administrator."
        Write-Host "Error details: $_"
        [console]::ReadKey($true)
        exit 1
    }
}

# Download MK1 Inventory Emulator from their 'official' GitHub repository
Get-File "$ghDownloadUrl" ".\MK1InvEmu.7z"
try {
    & ".\7zr.exe" x "MK1InvEmu.7z" "-o.\MK12\Binaries\Win64"
} catch {
    Write-Host "An error has occured during archive extraction attempt: $_" -Category ResourceUnavailable -ErrorAction SilentlyContinue
    Write-Host "Press any key to terminate the script..."
    [console]::ReadKey($true)
    exit 1
}

# Clean-up
Remove-Item .\MK1InvEmu.7z
Remove-Item .\7zr.exe

Write-Host "Everything is ready! Now follow the rest of the steps." -ForegroundColor Green
Write-Host "You can close this window now by pressing any key."
[console]::ReadKey($true)
exit 1