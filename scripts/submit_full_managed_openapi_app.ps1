[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z0-9]+$')]
    [string]$StoreKey,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$Port,

    [string]$ExpectedAppName
)

$ErrorActionPreference = 'Stop'
$store = $StoreKey.ToUpperInvariant()
$sessionName = "shein-full-$($store.ToLowerInvariant())"
$listPath = '/backstage/mange-applictions'
$checkPath = "$listPath/check"

function Invoke-AgentBrowser {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $raw = & agent-browser --session $sessionName --cdp "http://127.0.0.1:$Port" @Arguments --json 2>&1 | Out-String
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "agent-browser returned no output: $($Arguments -join ' ')"
    }

    $response = $raw | ConvertFrom-Json
    if (-not $response.success) {
        throw "agent-browser failed [$($Arguments -join ' ')]: $($response.error)"
    }
    return $response.data
}

function Invoke-BrowserExpression {
    param([Parameter(Mandatory = $true)][string]$Expression)
    return (Invoke-AgentBrowser -Arguments @('eval', $Expression)).result
}

function Get-CurrentUrl {
    return [string](Invoke-AgentBrowser -Arguments @('get', 'url')).url
}

function Wait-ForApplicationList {
    param([int]$TimeoutSeconds = 45)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $url = Get-CurrentUrl
        $uri = [Uri]$url
        if ($uri.AbsolutePath.TrimEnd('/') -eq $listPath) {
            return $url
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for the application list for ${store}; current URL: $url"
}

$url = Get-CurrentUrl
$uri = [Uri]$url
$path = $uri.AbsolutePath.TrimEnd('/')
$submittedNow = $false
$targetName = $ExpectedAppName

if ($path -eq $checkPath) {
    $formRaw = Invoke-BrowserExpression -Expression "JSON.stringify({appName:document.querySelector('#appName')?.value||'',mode:Array.from(new Set((document.querySelector('#mode')?.closest('.ant-select')?.innerText||'').split(/\s+/).filter(Boolean))).join(''),business:Array.from(new Set((document.querySelector('#businessFunction')?.closest('.ant-select')?.innerText||'').split(/\s+/).filter(Boolean))),description:document.querySelector('#appDesc')?.value||'',iconPreview:Array.from(document.images).some(img=>(img.currentSrc||img.src).startsWith('data:image/')),submitDisabled:Array.from(document.querySelectorAll('button')).find(b=>b.innerText.trim()==='提交审核')?.disabled??true})"
    $form = $formRaw | ConvertFrom-Json

    if ([string]::IsNullOrWhiteSpace($targetName)) {
        $targetName = $form.appName
    }

    $expectedBusiness = @('商品管理', '商品合规', '备货管理', '库存管理', '财务管理')
    $businessOk = (@($form.business).Count -eq $expectedBusiness.Count) -and
        (@(Compare-Object -ReferenceObject $expectedBusiness -DifferenceObject @($form.business)).Count -eq 0)
    $descriptionOk = $form.description.Contains('本应用由', [System.StringComparison]::Ordinal) -and
        $form.description.Contains('按合作模式隔离数据和权限', [System.StringComparison]::Ordinal)

    if ($form.appName -ne $targetName -or
        -not $targetName.StartsWith("$store-", [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $targetName.Contains('SHEIN全托运营中台', [System.StringComparison]::Ordinal) -or
        $form.mode -ne '全托管' -or
        -not $businessOk -or
        -not $descriptionOk -or
        -not $form.iconPreview -or
        $form.submitDisabled) {
        throw "Submission preflight failed for $store."
    }

    Invoke-AgentBrowser -Arguments @('find', 'role', 'button', 'click', '--name', '提交审核') | Out-Null
    Wait-ForApplicationList -TimeoutSeconds 45 | Out-Null
    $submittedNow = $true
} elseif ($path -ne $listPath) {
    throw "Unexpected page for ${store}: $url"
}

if ([string]::IsNullOrWhiteSpace($targetName)) {
    $targetName = [string](Invoke-BrowserExpression -Expression "Array.from(document.querySelectorAll('h3')).map(h=>h.innerText.trim()).find(name=>name.startsWith('$store-')&&name.includes('SHEIN全托运营中台'))||''")
}
if ([string]::IsNullOrWhiteSpace($targetName)) {
    throw "Could not determine the target full-managed application name for $store."
}

$escapedTarget = $targetName.Replace('\', '\\').Replace("'", "\'")
Invoke-AgentBrowser -Arguments @(
    'wait',
    '--fn',
    "Array.from(document.querySelectorAll('h3')).some(h=>h.innerText.trim()==='$escapedTarget')"
) | Out-Null

$readbackRaw = Invoke-BrowserExpression -Expression "JSON.stringify((()=>{const h=Array.from(document.querySelectorAll('h3')).find(item=>item.innerText.trim()==='$escapedTarget');const card=h?.parentElement?.parentElement?.parentElement;return{name:h?.innerText?.trim()||'',cardText:card?.innerText||'',subject:document.querySelector('span.mr-1.text-sm')?.innerText?.trim()||'',url:location.href}})())"
$readback = $readbackRaw | ConvertFrom-Json
$readbackLines = @($readback.cardText -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$mode = @($readbackLines | Where-Object { $_ -in @('全托管', '半托管', 'POP', '自运营', 'SHEIN自营') }) | Select-Object -First 1
$status = @($readbackLines | Where-Object { $_ -in @('审核中', '审核通过', '审核驳回', '已驳回') }) | Select-Object -First 1

if ($readback.name -ne $targetName -or $mode -ne '全托管' -or $status -notin @('审核中', '审核通过')) {
    throw "Submission readback failed for ${store}: $($readback.cardText -replace "`r?`n", ' / ')"
}

[pscustomobject]@{
    StoreKey = $store
    Port = $Port
    SubmittedNow = $submittedNow
    Subject = $readback.subject
    AppName = $readback.name
    CooperationMode = $mode
    Status = $status
    Readback = $readbackLines
    Url = $readback.url
    VerifiedAt = (Get-Date).ToString('o')
} | ConvertTo-Json -Depth 5
