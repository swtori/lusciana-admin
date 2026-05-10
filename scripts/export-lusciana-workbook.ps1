param(
    [Parameter(Mandatory = $true)]
    [string]$WorkbookPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Write-JsonValue {
    param(
        $Value,

        [Parameter(Mandatory = $true)]
        [System.IO.StreamWriter]$Writer
    )

    if ($null -eq $Value) {
        $Writer.Write('null')
        return
    }

    if ($Value -is [bool]) {
        $Writer.Write(($Value.ToString()).ToLowerInvariant())
        return
    }

    if ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or
        $Value -is [decimal] -or $Value -is [double] -or $Value -is [single]) {
        $Writer.Write(([System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture)))
        return
    }

    $text = [string]$Value
    $text = $text.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    $Writer.Write('"')
    $Writer.Write($text)
    $Writer.Write('"')
}

function Get-ZipEntryText {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.Compression.ZipArchive]$Zip,

        [Parameter(Mandatory = $true)]
        [string]$EntryName
    )

    $entry = $Zip.Entries | Where-Object { $_.FullName -eq $EntryName }
    if ($null -eq $entry) {
        return $null
    }

    $stream = $entry.Open()
    $reader = [System.IO.StreamReader]::new($stream)
    try {
        return $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Get-ColumnIndexFromReference {
    param([string]$CellReference)

    $letters = ($CellReference -replace '[^A-Z]', '')
    $index = 0

    foreach ($letter in $letters.ToCharArray()) {
        $index = ($index * 26) + ([int][char]$letter - [int][char]'A' + 1)
    }

    return $index
}

function Get-RowIndexFromReference {
    param([string]$CellReference)

    return [int]($CellReference -replace '[^0-9]', '')
}

function Resolve-SharedString {
    param($SharedStrings, [int]$Index)

    if ($Index -lt 0 -or $Index -ge $SharedStrings.Count) {
        return ''
    }

    return $SharedStrings[$Index]
}

function Get-CellValue {
    param(
        $Cell,
        $SharedStrings
    )

    $type = [string]$Cell.GetAttribute('t')

    if ($type -eq 'inlineStr') {
        $inlineTextNode = $Cell.SelectSingleNode("./*[local-name()='is']/*[local-name()='t']")
        $inlineRichTextNodes = $Cell.SelectNodes("./*[local-name()='is']/*[local-name()='r']/*[local-name()='t']")

        if ($inlineTextNode) {
            return [string]$inlineTextNode.InnerText
        }

        if ($inlineRichTextNodes) {
            return (($inlineRichTextNodes | ForEach-Object { [string]$_.InnerText }) -join '')
        }

        return ''
    }

    $valueNode = $Cell.SelectSingleNode("./*[local-name()='v']")
    if (-not $valueNode) {
        return $null
    }

    $raw = [string]$valueNode.InnerText

    if ($type -eq 's') {
        return Resolve-SharedString -SharedStrings $SharedStrings -Index ([int]$raw)
    }

    if ($type -eq 'b') {
        return ($raw -eq '1')
    }

    $number = 0.0
    if ([double]::TryParse($raw, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
        if ([Math]::Abs($number - [Math]::Round($number)) -lt 0.0000001) {
            return [int64][Math]::Round($number)
        }
        return $number
    }

    return $raw
}

$directory = Split-Path -Path $OutputPath -Parent
if ($directory -and -not (Test-Path $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
}

$zip = $null
$writer = $null

try {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($WorkbookPath)

    [xml]$workbookXml = Get-ZipEntryText -Zip $zip -EntryName 'xl/workbook.xml'
    [xml]$workbookRelsXml = Get-ZipEntryText -Zip $zip -EntryName 'xl/_rels/workbook.xml.rels'

    $sharedStrings = @()
    $sharedStringsText = Get-ZipEntryText -Zip $zip -EntryName 'xl/sharedStrings.xml'
    if ($sharedStringsText) {
        [xml]$sharedStringsXml = $sharedStringsText
        foreach ($item in $sharedStringsXml.SelectNodes("//*[local-name()='sst']/*[local-name()='si']")) {
            $textNode = $item.SelectSingleNode("./*[local-name()='t']")
            $richTextNodes = $item.SelectNodes("./*[local-name()='r']/*[local-name()='t']")

            if ($textNode) {
                $sharedStrings += [string]$textNode.InnerText
            } elseif ($richTextNodes) {
                $sharedStrings += (($richTextNodes | ForEach-Object { [string]$_.InnerText }) -join '')
            } else {
                $sharedStrings += ''
            }
        }
    }

    $relationshipMap = @{}
    foreach ($relationship in $workbookRelsXml.SelectNodes("//*[local-name()='Relationship']")) {
        $relationshipMap[[string]$relationship.Id] = [string]$relationship.Target
    }

    $writer = [System.IO.StreamWriter]::new($OutputPath, $false, [System.Text.UTF8Encoding]::new($false))
    $writer.Write('{"workbook":')
    Write-JsonValue -Value ([System.IO.Path]::GetFileName($WorkbookPath)) -Writer $writer
    $writer.Write(',"sheets":[')

    $isFirstSheet = $true

    foreach ($sheet in $workbookXml.SelectNodes("//*[local-name()='workbook']/*[local-name()='sheets']/*[local-name()='sheet']")) {
        $sheetName = [string]$sheet.GetAttribute('name')
        $relationshipId = [string]$sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
        $target = $relationshipMap[$relationshipId]
        if (-not $target) {
            continue
        }

        $sheetPath = 'xl/' + $target.Replace('\', '/')
        [xml]$sheetXml = Get-ZipEntryText -Zip $zip -EntryName $sheetPath

        $rowCount = 0
        $columnCount = 0
        $dimensionNode = $sheetXml.SelectSingleNode("//*[local-name()='worksheet']/*[local-name()='dimension']")
        $dimensionRef = if ($dimensionNode) { [string]$dimensionNode.GetAttribute('ref') } else { '' }
        if ($dimensionRef -and $dimensionRef.Contains(':')) {
            $endRef = $dimensionRef.Split(':')[1]
            $rowCount = Get-RowIndexFromReference -CellReference $endRef
            $columnCount = Get-ColumnIndexFromReference -CellReference $endRef
        }

        if ($rowCount -le 0 -or $columnCount -le 0) {
            foreach ($rowNode in $sheetXml.SelectNodes("//*[local-name()='worksheet']/*[local-name()='sheetData']/*[local-name()='row']")) {
                $rowCount = [Math]::Max($rowCount, [int]$rowNode.GetAttribute('r'))
                foreach ($cell in $rowNode.SelectNodes("./*[local-name()='c']")) {
                    $columnCount = [Math]::Max($columnCount, (Get-ColumnIndexFromReference -CellReference ([string]$cell.GetAttribute('r'))))
                }
            }
        }

        $rowsByIndex = @{}
        foreach ($rowNode in $sheetXml.SelectNodes("//*[local-name()='worksheet']/*[local-name()='sheetData']/*[local-name()='row']")) {
            $rowMap = @{}
            foreach ($cell in $rowNode.SelectNodes("./*[local-name()='c']")) {
                $columnIndex = Get-ColumnIndexFromReference -CellReference ([string]$cell.GetAttribute('r'))
                $rowMap[$columnIndex] = Get-CellValue -Cell $cell -SharedStrings $sharedStrings
            }
            $rowsByIndex[[int]$rowNode.GetAttribute('r')] = $rowMap
        }

        if (-not $isFirstSheet) {
            $writer.Write(',')
        }
        $isFirstSheet = $false

        $writer.Write('{"name":')
        Write-JsonValue -Value $sheetName -Writer $writer
        $writer.Write(',"rowCount":')
        $writer.Write($rowCount)
        $writer.Write(',"columnCount":')
        $writer.Write($columnCount)
        $writer.Write(',"rows":[')

        for ($rowIndex = 1; $rowIndex -le $rowCount; $rowIndex++) {
            if ($rowIndex -gt 1) {
                $writer.Write(',')
            }

            $writer.Write('[')
            $rowMap = $rowsByIndex[$rowIndex]

            for ($columnIndex = 1; $columnIndex -le $columnCount; $columnIndex++) {
                if ($columnIndex -gt 1) {
                    $writer.Write(',')
                }

                $value = $null
                if ($rowMap -and $rowMap.ContainsKey($columnIndex)) {
                    $value = $rowMap[$columnIndex]
                }

                Write-JsonValue -Value $value -Writer $writer
            }

            $writer.Write(']')
        }

        $writer.Write(']}')
        $writer.Flush()
    }

    $writer.Write(']}')
    $writer.Flush()
} finally {
    if ($writer -ne $null) {
        $writer.Dispose()
    }

    if ($zip -ne $null) {
        $zip.Dispose()
    }
}
