$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
function Await-Operation($Operation, $ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and
        $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object {
    $_.Language -eq 'ko-KR' -and $_.Gender.ToString() -eq 'Female'
} | Sort-Object @{ Expression = { if ($_.DisplayName -match 'Heami') { 0 } else { 1 } } } | Select-Object -First 1
if (-not $voice) { throw 'Korean female voice is not installed.' }
$synth.Voice = $voice
$stream = Await-Operation ($synth.SynthesizeTextToStreamAsync([string]$inputData.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = [Windows.Storage.Streams.DataReader]::new($stream)
$null = Await-Operation ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
$bytes = New-Object byte[] ([int]$stream.Size)
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes([string]$inputData.path, $bytes)
$reader.Dispose()
$synth.Dispose()
