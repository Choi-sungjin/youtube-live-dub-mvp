$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice = $synth.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $request.language
    } | Select-Object -First 1
    if (-not $voice) { throw "No Windows speech voice is installed for language '$($request.language)'." }
    $synth.SelectVoice($voice.VoiceInfo.Name)
    $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int][Math]::Round([Math]::Log([double]$request.speed, 1.15))))
    $synth.SetOutputToWaveFile([string]$request.outputPath)
    $synth.Speak([string]$request.text)
    $synth.SetOutputToNull()
    @{ voice = $voice.VoiceInfo.Name; language = $voice.VoiceInfo.Culture.Name } | ConvertTo-Json -Compress
} finally {
    $synth.Dispose()
}
