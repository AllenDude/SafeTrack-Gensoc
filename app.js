document.getElementById('applicationForm').addEventListener('submit', function(e) {
    e.preventDefault();

    const submitBtn = document.getElementById('submitBtn');
    const statusMessage = document.getElementById('statusMessage');
    
    // Disable button to prevent double submission
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    // Gather form data
    const student_id = document.getElementById('student_id').value;
    const event_name = document.getElementById('event_name').value;
    const target_role = document.getElementById('target_role').value;
    const skills = document.getElementById('skills').value;

    // Validate Student ID Format (YY-XXXX)
    const idPattern = /^\d{2}-\d{4}$/;
    if (!idPattern.test(student_id)) {
        statusMessage.textContent = 'Invalid ID format. Please use YY-XXXX (e.g., 26-1711).';
        statusMessage.className = 'error';
        statusMessage.classList.remove('hidden');
        
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Application';
        return; // Stops the submission
    }

    // Structure data for SheetDB
    const payload = {
        data: [
            {
                "id": "APP-" + Date.now(),
                "student_id": student_id,
                "event_name": event_name,
                "target_role": target_role,
                "skills": skills,
                "status": "Pending Review"
            }
        ]
    };

    // Send POST request to your SheetDB API
    fetch('https://sheetdb.io/api/v1/s8jmt1jiwzzka', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    })
    .then((response) => response.json())
    .then((data) => {
        // Handle success
        statusMessage.textContent = 'Application submitted successfully! Your ID is hidden from reviewers.';
        statusMessage.className = 'success';
        statusMessage.classList.remove('hidden');
        document.getElementById('applicationForm').reset();
    })
    .catch((error) => {
        // Handle error
        console.error('Error:', error);
        statusMessage.textContent = 'Failed to submit application. Please try again.';
        statusMessage.className = 'error';
        statusMessage.classList.remove('hidden');
    })
    .finally(() => {
        // Re-enable button
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Application';
    });
});
