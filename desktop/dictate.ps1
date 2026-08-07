# Dictation for the Ask Claude box.
#
# Chromium's speech recognition is in Electron but does not work in it — the
# build ships without the backend it calls, so starting it fails immediately with
# a network error, every time, whatever you do. What is left that needs no key,
# no account and no internet is the speech engine already in Windows.
#
# Writes one JSON object per line to standard output and exits when the speaking
# stops. Nothing is recorded, nothing is written to disk, and no audio leaves the
# machine — the recogniser is running here.

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Speech
} catch {
  Write-Output (@{ error = 'Windows speech is not available on this machine.' } | ConvertTo-Json -Compress)
  exit 1
}

# en-AU is rarely installed; en-GB is the closer of the two that usually are.
$want = $env:BATHROOM_DICTATE_LANG
if (-not $want) { $want = 'en-GB' }
$installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if (-not $installed -or $installed.Count -eq 0) {
  Write-Output (@{ error = 'No speech recogniser is installed. Add one under Windows Settings, Time and language, Speech.' } | ConvertTo-Json -Compress)
  exit 1
}
$pick = $installed | Where-Object { $_.Culture.Name -eq $want } | Select-Object -First 1
if (-not $pick) { $pick = $installed | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }
if (-not $pick) { $pick = $installed[0] }

$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine $pick
try {
  $rec.SetInputToDefaultAudioDevice()
} catch {
  Write-Output (@{ error = 'No microphone. Check the input device in Windows sound settings.' } | ConvertTo-Json -Compress)
  exit 1
}
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))

# Long enough to get started, short enough that it stops on its own when the
# sentence is finished rather than sitting there with the microphone open.
$rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(10)
$rec.BabbleTimeout         = [TimeSpan]::FromSeconds(4)
$rec.EndSilenceTimeout     = [TimeSpan]::FromSeconds(1.2)

Write-Output (@{ ready = $true; culture = $pick.Culture.Name } | ConvertTo-Json -Compress)

while ($true) {
  $result = $rec.Recognize()
  if ($null -eq $result) { break }              # silence: they have finished
  if ($result.Text) {
    Write-Output (@{ text = $result.Text; confidence = [math]::Round($result.Confidence, 2) } | ConvertTo-Json -Compress)
  }
}
$rec.Dispose()
