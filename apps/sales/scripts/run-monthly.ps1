$ErrorActionPreference = 'Stop'
$SalesRoot = Split-Path -Parent $PSScriptRoot
$SalesRunner = Join-Path $PSScriptRoot 'monthly.mjs'
$SalesNode = (Get-Command node.exe -ErrorAction Stop).Source
$output = & $SalesNode $SalesRunner
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($line in $output) {
  try {
    $result = $line | ConvertFrom-Json
    if ($result.state -in @('complete','needs_action','failed')) {
      $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
      $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
      $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
      $message = if ($result.state -eq 'complete') { 'Monthly report is ready. Open Sales Desk to review.' } else { 'Monthly report needs attention. Open Sales Desk for missing data.' }
      $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Wucheng Sales Desk</text><text>' + $message + '</text></binding></visual></toast>')
      $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Wucheng.SalesDesk').Show($toast)
    }
  } catch { Write-Warning 'Windows notification was unavailable. Details remain in Sales Desk.' }
}
