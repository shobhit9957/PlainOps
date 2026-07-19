# Static syntax verification: every az command PLAINOPS constructs must exist
# and every flag we pass must appear in that command's --help output.
$az = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
$checks = @(
  @{ cmd = 'account show';                                   flags = @('--output') },
  @{ cmd = 'containerapp list';                              flags = @('--query','--output') },
  @{ cmd = 'containerapp show';                              flags = @('--name','--resource-group','--query','--output') },
  @{ cmd = 'containerapp env show';                          flags = @('--ids','--query','--output') },
  @{ cmd = 'containerapp hostname bind';                     flags = @('--name','--resource-group','--hostname','--environment','--validation-method') },
  @{ cmd = 'functionapp list';                               flags = @('--query','--output') },
  @{ cmd = 'functionapp deployment source config-zip';       flags = @('--resource-group','--name','--src') },
  @{ cmd = 'postgres flexible-server list';                  flags = @('--resource-group','--query','--output') },
  @{ cmd = 'aks list';                                       flags = @('--query','--output') },
  @{ cmd = 'monitor activity-log list';                      flags = @('--offset','--status','--max-events','--query','--output') },
  @{ cmd = 'network dns zone list';                          flags = @('--query','--output') },
  @{ cmd = 'network dns record-set a add-record';            flags = @('--zone-name','--resource-group','--record-set-name','--ipv4-address') },
  @{ cmd = 'network dns record-set cname set-record';        flags = @('--zone-name','--resource-group','--record-set-name','--cname') },
  @{ cmd = 'network dns record-set txt add-record';          flags = @('--zone-name','--resource-group','--record-set-name','--value') },
  @{ cmd = 'acr build';                                      flags = @('--registry','--image') }
)
$fail = 0
foreach ($c in $checks) {
  $args = $c.cmd.Split(' ') + '--help'
  $help = (& $az @args 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { Write-Output "FAIL  az $($c.cmd)  -- command not found (exit $LASTEXITCODE)"; $fail++; continue }
  $missing = @($c.flags | Where-Object { $help -notmatch [regex]::Escape($_) })
  if ($missing.Count -gt 0) { Write-Output "FAIL  az $($c.cmd)  -- flags missing from help: $($missing -join ', ')"; $fail++ }
  else { Write-Output "PASS  az $($c.cmd)" }
}
Write-Output "---- $fail failure(s) of $($checks.Count) commands ----"
