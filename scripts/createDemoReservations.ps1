# PowerShell script to create demo reservations
# Usage: .\createDemoReservations.ps1

$BASE_URL = if ($env:API_URL) { $env:API_URL } else { "http://localhost:3000" }
$JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2OTEwYjdkMWE3MDUyOGZkMjkyMTFkNzMiLCJlbWFpbCI6InZ0NjQ4NEBnbWFpbC5jb20iLCJyb2xlIjoiQWRtaW4iLCJwcm9wZXJ0eUNvZGUiOiJERU1PNzc3IiwicHJvcGVydHlJZCI6IjY5MTBiN2M2ZDI0MWY5Nzc0Njk2NDUzZSIsImlhdCI6MTc2NTMwNTE1MCwiZXhwIjoxNzY1OTA5OTUwfQ.7R6O1b8y5iaUVNeCSkWMxwzmqqNy5UFdiASDeeA8DkU"

# Indian names pool
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

$sources = @('direct', 'website', 'booking.com', 'agoda', 'expedia', 'phone', 'walk-in')
$paymentMethods = @('Cash', 'Card', 'UPI', 'Bank Transfer')
$mealPlans = @('EP', 'CP', 'MAP', 'AP')
$statuses = @('confirmed', 'checked-in')

function Get-RandomIndianName {
    $firstName = $firstNames | Get-Random
    $lastName = $lastNames | Get-Random
    return "$firstName $lastName"
}

function Get-RandomEmail {
    param($name)
    $cleanName = $name.ToLower() -replace '\s+', ''
    $domains = @('gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'rediffmail.com')
    $domain = $domains | Get-Random
    $randomNum = Get-Random -Minimum 1000 -Maximum 9999
    return "${cleanName}${randomNum}@${domain}"
}

function Get-RandomPhoneNumber {
    $number = Get-Random -Minimum 1000000000 -Maximum 9999999999
    return "91$number"
}

function Get-RandomDate {
    param($startDate, $endDate)
    $startTicks = $startDate.Ticks
    $endTicks = $endDate.Ticks
    $randomTicks = Get-Random -Minimum $startTicks -Maximum $endTicks
    return [DateTime]::new($randomTicks)
}

function Format-Date {
    param($date)
    return $date.ToString("yyyy-MM-dd")
}

function Add-Days {
    param($date, $days)
    return $date.AddDays($days)
}

# Fetch room types
Write-Host "Fetching room types..." -ForegroundColor Cyan
try {
    $headers = @{
        "Authorization" = "Bearer $JWT_TOKEN"
        "Content-Type" = "application/json"
    }
    $response = Invoke-RestMethod -Uri "$BASE_URL/api/foundation/getRoomTypes" -Method Get -Headers $headers
    $roomTypes = $response
    Write-Host "Found $($roomTypes.Count) room type(s)`n" -ForegroundColor Green
} catch {
    Write-Host "Error fetching room types: $_" -ForegroundColor Red
    Write-Host "Please ensure the server is running at $BASE_URL" -ForegroundColor Yellow
    exit 1
}

if ($roomTypes.Count -eq 0) {
    Write-Host "No room types found. Please create room types first." -ForegroundColor Red
    exit 1
}

# Date range: December 10, 2024 to January 5, 2025
$startDate = [DateTime]::new(2024, 12, 10)
$endDate = [DateTime]::new(2025, 1, 5)

# Generate 30 reservations
$reservations = @()
$totalReservations = 30

Write-Host "Generating $totalReservations reservations...`n" -ForegroundColor Cyan

for ($i = 0; $i -lt $totalReservations; $i++) {
    $guestName = Get-RandomIndianName
    $guestEmail = Get-RandomEmail -name $guestName
    $guestNumber = Get-RandomPhoneNumber
    
    # Random check-in date
    $checkInDate = Get-RandomDate -startDate $startDate -endDate $endDate
    
    # Random stay duration: 1 to 5 days
    $stayDuration = Get-Random -Minimum 1 -Maximum 6
    $checkOutDate = Add-Days -date $checkInDate -days $stayDuration
    
    # Ensure checkout doesn't exceed end date
    if ($checkOutDate -gt $endDate) {
        $checkOutDate = $endDate
        $checkInDate = $checkOutDate.AddDays(-$stayDuration)
        if ($checkInDate -lt $startDate) {
            $checkInDate = $startDate
            $checkOutDate = Add-Days -date $checkInDate -days $stayDuration
            if ($checkOutDate -gt $endDate) {
                $checkOutDate = $endDate
            }
        }
    }
    
    # Random room type
    $roomType = $roomTypes | Get-Random
    
    # Random number of rooms: 1 to 5
    $numberOfRooms = Get-Random -Minimum 1 -Maximum 6
    
    # Random total guests: at least numberOfRooms, up to numberOfRooms * 3
    $totalGuest = $numberOfRooms + (Get-Random -Minimum 0 -Maximum ($numberOfRooms * 2))
    
    # Random amounts
    $baseRate = if ($roomType.baseRate) { $roomType.baseRate } else { 2000 }
    $totalAmount = ($baseRate * $numberOfRooms * $stayDuration) + (Get-Random -Minimum 0 -Maximum 5000)
    $payedAmount = [Math]::Floor($totalAmount * (0.1 + (Get-Random -Minimum 0 -Maximum 1) * 0.4)) # 10-50% advance
    
    # Random other fields
    $source = $sources | Get-Random
    $paymentMethod = $paymentMethods | Get-Random
    $mealPlan = $mealPlans | Get-Random
    $status = $statuses | Get-Random
    
    # Calculate meal plan details
    $mealPlanRate = Get-Random -Minimum 200 -Maximum 700
    $mealPlanGuestCount = [Math]::Floor($totalGuest * (0.5 + (Get-Random -Minimum 0 -Maximum 1) * 0.5))
    $mealPlanNights = $stayDuration
    $mealPlanAmount = $mealPlanRate * $mealPlanGuestCount * $mealPlanNights
    
    $reservationData = @{
        guestName = $guestName
        guestEmail = $guestEmail
        guestNumber = $guestNumber
        checkInDate = Format-Date -date $checkInDate
        checkOutDate = Format-Date -date $checkOutDate
        roomType = $roomType._id
        numberOfRooms = $numberOfRooms
        totalGuest = $totalGuest
        totalAmount = $totalAmount
        payedAmount = $payedAmount
        paymentMethod = $paymentMethod
        Source = $source
        status = $status
        mealPlan = $mealPlan
        mealPlanAmount = $mealPlanAmount
        mealPlanGuestCount = $mealPlanGuestCount
        mealPlanNights = $mealPlanNights
        mealPlanRate = $mealPlanRate
        roomNumbers = @()
        notes = @()
    }
    
    $reservations += $reservationData
}

# Create reservations
Write-Host "Creating reservations via API...`n" -ForegroundColor Cyan
$successCount = 0
$failCount = 0

$headers = @{
    "Authorization" = "Bearer $JWT_TOKEN"
    "Content-Type" = "application/json"
}

for ($i = 0; $i -lt $reservations.Count; $i++) {
    $reservation = $reservations[$i]
    try {
        $body = $reservation | ConvertTo-Json -Depth 10
        $response = Invoke-RestMethod -Uri "$BASE_URL/api/frontoffice/reservations" -Method Post -Headers $headers -Body $body
        $successCount++
        Write-Host "✓ [$($i + 1)/$totalReservations] Created reservation for $($reservation.guestName) ($($reservation.checkInDate) to $($reservation.checkOutDate))" -ForegroundColor Green
    } catch {
        $failCount++
        $errorMsg = if ($_.ErrorDetails.Message) { 
            ($_.ErrorDetails.Message | ConvertFrom-Json).message 
        } else { 
            $_.Exception.Message 
        }
        Write-Host "✗ [$($i + 1)/$totalReservations] Failed to create reservation for $($reservation.guestName): $errorMsg" -ForegroundColor Red
    }
    
    # Small delay to avoid overwhelming the server
    Start-Sleep -Milliseconds 100
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "Total reservations: $totalReservations"
Write-Host "Successful: $successCount" -ForegroundColor Green
Write-Host "Failed: $failCount" -ForegroundColor $(if ($failCount -gt 0) { "Red" } else { "Green" })

