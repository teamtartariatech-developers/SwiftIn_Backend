# PowerShell script to delete demo reservations
# Usage: .\deleteDemoReservations.ps1

$BASE_URL = if ($env:API_URL) { $env:API_URL } else { "http://localhost:3000" }
$JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2OTEwYjdkMWE3MDUyOGZkMjkyMTFkNzMiLCJlbWFpbCI6InZ0NjQ4NEBnbWFpbC5jb20iLCJyb2xlIjoiQWRtaW4iLCJwcm9wZXJ0eUNvZGUiOiJERU1PNzc3IiwicHJvcGVydHlJZCI6IjY5MTBiN2M2ZDI0MWY5Nzc0Njk2NDUzZSIsImlhdCI6MTc2NTMwNTE1MCwiZXhwIjoxNzY1OTA5OTUwfQ.7R6O1b8y5iaUVNeCSkWMxwzmqqNy5UFdiASDeeA8DkU"

# Indian names pool (same as in create script)
$firstNames = @(
    'Rajesh', 'Priya', 'Amit', 'Anjali', 'Vikram', 'Kavita', 'Rahul', 'Sneha',
    'Arjun', 'Meera', 'Karan', 'Divya', 'Suresh', 'Pooja', 'Nikhil', 'Riya',
    'Aditya', 'Shreya', 'Rohan', 'Neha', 'Varun', 'Ananya', 'Kunal', 'Isha',
    'Siddharth', 'Tanvi', 'Manish', 'Aishwarya', 'Gaurav', 'Swati'
)

$lastNames = @(
    'Sharma', 'Patel', 'Kumar', 'Singh', 'Gupta', 'Mehta', 'Reddy', 'Rao',
    'Verma', 'Jain', 'Shah', 'Desai', 'Joshi', 'Malhotra', 'Agarwal', 'Nair',
    'Iyer', 'Menon', 'Pillai', 'Nair', 'Chopra', 'Kapoor', 'Bansal', 'Arora',
    'Khanna', 'Seth', 'Bhatia', 'Goyal', 'Saxena', 'Tiwari'
)

function Test-IndianName {
    param($name)
    if (-not $name) { return $false }
    $nameParts = $name -split '\s+'
    if ($nameParts.Count -lt 2) { return $false }
    
    $firstName = $nameParts[0]
    $lastName = $nameParts[-1]
    
    return ($firstNames -contains $firstName) -and ($lastNames -contains $lastName)
}

function Test-DateInRange {
    param($dateString, $startDate, $endDate)
    $date = [DateTime]::Parse($dateString)
    return ($date -ge $startDate) -and ($date -le $endDate)
}

# Fetch all reservations
Write-Host "Fetching all reservations..." -ForegroundColor Cyan
try {
    $headers = @{
        "Authorization" = "Bearer $JWT_TOKEN"
        "Content-Type" = "application/json"
    }
    $response = Invoke-RestMethod -Uri "$BASE_URL/api/frontoffice/reservations/all" -Method Get -Headers $headers
    $allReservations = $response
    Write-Host "Found $($allReservations.Count) total reservation(s)`n" -ForegroundColor Green
} catch {
    Write-Host "Error fetching reservations: $_" -ForegroundColor Red
    exit 1
}

# Date range: December 10, 2024 to January 5, 2025
$startDate = [DateTime]::new(2024, 12, 10)
$endDate = [DateTime]::new(2025, 1, 5, 23, 59, 59)

Write-Host "Looking for reservations between $($startDate.ToString('yyyy-MM-dd')) and $($endDate.ToString('yyyy-MM-dd'))...`n" -ForegroundColor Cyan

# Filter demo reservations
$demoReservations = $allReservations | Where-Object {
    $checkInDate = [DateTime]::Parse($_.checkInDate)
    $checkOutDate = [DateTime]::Parse($_.checkOutDate)
    
    # Check if either check-in or check-out is in our date range
    $inDateRange = ($checkInDate -ge $startDate -and $checkInDate -le $endDate) -or
                   ($checkOutDate -ge $startDate -and $checkOutDate -le $endDate) -or
                   ($checkInDate -le $startDate -and $checkOutDate -ge $endDate)
    
    # Also check if name matches Indian name pattern
    $hasIndianName = Test-IndianName -name $_.guestName
    
    return $inDateRange -and $hasIndianName
}

Write-Host "Found $($demoReservations.Count) demo reservation(s) to delete`n" -ForegroundColor Yellow

if ($demoReservations.Count -eq 0) {
    Write-Host "No demo reservations found to delete." -ForegroundColor Green
    exit 0
}

# Show what will be deleted
Write-Host "Reservations to be deleted:" -ForegroundColor Cyan
$index = 1
foreach ($res in $demoReservations) {
    Write-Host "  $index. $($res.guestName) - $($res.checkInDate) to $($res.checkOutDate) (Status: $($res.status))"
    $index++
}
Write-Host ""

# Delete reservations
Write-Host "Deleting reservations...`n" -ForegroundColor Cyan
$successCount = 0
$failCount = 0
$skippedCount = 0

$headers = @{
    "Authorization" = "Bearer $JWT_TOKEN"
    "Content-Type" = "application/json"
}

$index = 1
foreach ($reservation in $demoReservations) {
    try {
        Invoke-RestMethod -Uri "$BASE_URL/api/frontoffice/reservations/$($reservation._id)" -Method Delete -Headers $headers | Out-Null
        $successCount++
        Write-Host "✓ [$index/$($demoReservations.Count)] Deleted reservation for $($reservation.guestName) ($($reservation.checkInDate) to $($reservation.checkOutDate))" -ForegroundColor Green
    } catch {
        $errorMsg = if ($_.ErrorDetails.Message) { 
            ($_.ErrorDetails.Message | ConvertFrom-Json).message 
        } else { 
            $_.Exception.Message 
        }
        
        # Check if it's because reservation is checked-in/out
        if ($errorMsg -like "*Cannot delete*" -or $errorMsg -like "*checked-in*" -or $errorMsg -like "*checked-out*") {
            $skippedCount++
            Write-Host "⚠ [$index/$($demoReservations.Count)] Skipped $($reservation.guestName) ($($reservation.status)): $errorMsg" -ForegroundColor Yellow
        } else {
            $failCount++
            Write-Host "✗ [$index/$($demoReservations.Count)] Failed to delete reservation for $($reservation.guestName): $errorMsg" -ForegroundColor Red
        }
    }
    
    $index++
    # Small delay to avoid overwhelming the server
    Start-Sleep -Milliseconds 100
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "Total demo reservations found: $($demoReservations.Count)"
Write-Host "Successfully deleted: $successCount" -ForegroundColor Green
Write-Host "Skipped (checked-in/out): $skippedCount" -ForegroundColor Yellow
Write-Host "Failed: $failCount" -ForegroundColor $(if ($failCount -gt 0) { "Red" } else { "Green" })

