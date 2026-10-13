with open('C:\\Users\\Faida\\Desktop\\BLECA smartlabs\\bleca-finance\\src\\tests\\integration\\m15-period-close.test.ts', 'r') as f:
    content = f.read()

# Find the test 8 block and print the submitResult line area
idx = content.find("const submitResult = await submitCloseForSignOff(period.id, organizationId, ceoId, 'M15 CEO', ['CEO']);")
if idx >= 0:
    print("Found submitResult at index", idx)
    # Print 200 chars after
    print(content[idx:idx+300])
else:
    print("submitResult not found")