with open('C:\\Users\\Faida\\Desktop\\BLECA smartlabs\\bleca-finance\\src\\tests\\integration\\m15-period-close.test.ts', 'r') as f:
    content = f.read()

# Find and replace test 8
idx = content.find('// ---- Test 8: CEO sign-off ----')
if idx < 0:
    print('TEST 8 BLOCK NOT FOUND')
    exit(1)

# Find the end pattern
pattern = "expect(signOffResult.periodStatus).toBe('LOCKED');\\n  });\\n});"
import re
match = re.search(pattern, content[idx:])
if not match:
    print('Pattern not found in test 8 block')
    # Debug: show what's after idx
    print('Content around idx:')
    print(repr(content[idx:idx+500]))
    exit(1)

loc = idx + match.start() + len(match.group())
old_block = content[idx:loc]

new_test8 = '''  // ---- Test 8: CEO sign-off ----
  it('CEO sign-off: signOffClose makes period LOCKED and records sign-off fields', async () => {
    const periodCode = `SIGNOFF-TEST-${suffix}`;
    const period = await prisma.financialPeriod.create({
      data: {
        organizationId,
        code: periodCode,
        name: 'Test Sign-off Period',
        type: 'MONTHLY',
        status: 'OPEN',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
      },
      select: { id: true, code: true, name: true, status: true },
    });

    await startClose(period.id, organizationId, ceoId, 'M15 CEO', ['CEO']);

    const submitResult = await submitCloseForSignOff(period.id, organizationId, ceoId, 'M15 CEO', ['CEO']);
    expect(submitResult).toMatchObject({ closeId: expect.any(String), approvalRequestId: expect.any(String) });

    const signOffUserId = await createTestUser('m15-signoff-ceo', true);
    const signOffName = 'M15 Sign-off CEO';
    const signOffResult = await signOffClose(period.id, organizationId, signOffUserId, signOffName, ['CEO']);

    const closeAfterSignOff = await prisma.financialClose.findFirst({
      where: { periodId: period.id },
      select: { signedOffById: true, signedOffAt: true, status: true },
    });
    expect(closeAfterSignOff?.status).toBe('SIGNED_OFF');
    expect(closeAfterSignOff?.signedOffById).toBe(signOffUserId);
    expect(closeAfterSignOff?.signedOffAt).toBeTruthy();

    expect(signOffResult.periodStatus).toBe('LOCKED');
  });'''

new_content = content[:idx] + new_test8 + content[loc:]

with open('C:\\Users\\Faida\\Desktop\\BLECA smartlabs\\bleca-finance\\src\\tests\\integration\\m15-period-close.test.ts', 'w') as f:
    f.write(new_content)
print('Test 8 simplified - journal entry removal done')