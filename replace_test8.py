with open('C:\\Users\\Faida\\Desktop\\BLECA smartlabs\\bleca-finance\\src\\tests\\integration\\m15-period-close.test.ts', 'r') as f:
    content = f.read()

# Find the test 8 section
idx = content.find('// ---- Test 8: CEO sign-off ----')
if idx < 0:
    print('TEST 8 BLOCK NOT FOUND')
    exit(1)

# New test 8 content
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

    // Set up balanced journal entries so financial statements tie-check passes
    const debitAccount = await prisma.account.findFirst({
      where: { organizationId, subCategory: 'CASH', type: 'ASSET' },
      select: { id: true },
    });
    const creditAccount = await prisma.account.findFirst({
      where: { organizationId, subCategory: 'RETAINED_EARNINGS', type: 'EQUITY' },
      select: { id: true },
    });
    if (debitAccount && creditAccount) {
      await prisma.journalEntry.create({
        data: {
          organizationId,
          periodId: period.id,
          type: 'OPENING_BALANCE',
          status: 'POSTED',
          source: 'MANUAL',
          description: 'Opening balance test',
          postedById: ceoId,
          postedAt: new Date(),
          lines: {
            create: [
              {
                organizationId,
                lineNumber: 1,
                accountId: debitAccount.id,
                debit: 1000.00,
                credit: 0.00,
                currencyCode: 'TZS',
                baseAmount: 1000.00,
                description: 'Opening debit to cash',
              },
              {
                organizationId,
                lineNumber: 2,
                accountId: creditAccount.id,
                debit: 0.00,
                credit: 1000.00,
                currencyCode: 'TZS',
                baseAmount: 1000.00,
                description: 'Opening credit to equity',
              },
            ],
          },
        },
        select: { id: true },
      });
    }

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

# Find the end of test 8 block - look for the closing pattern
pattern = "expect(signOffResult.periodStatus).toBe('LOCKED');\n  });\n});"
loc = content.find(pattern, idx)
if loc < 0:
    print("Pattern not found, trying alternative...")
    # Try to find by looking for the end of test 8
    # The test 8 it block ends with });} );
    # Let me search for the closing braces
    substr = content[idx:]
    # Find the last '});' in the test area
    # Actually, let me just find // ---- after test 8
    next_idx = content.find('// ----', idx + 100)
    if next_idx >= 0:
        new_content = content[:idx] + content[next_idx:]
        with open('C:\\Users\\Faida\\Desktop\\BLECA smartlabs\\bleca-finance\\src\\tests\\integration\\m15-period-close.test.ts', 'w') as f:
            f.write(new_content)
        print('Replaced using next // ---- marker')
    else:
        print("Could not find replacement point")
        print("Around test 8 (first 300 chars):")
        print(substr[:300])
else:
    old_block = content[idx:loc + len(pattern)]
    new_content = content[:idx] + new_test8 + content[loc + len(pattern):]
    
    with open('C:\\Users\\Faida\\Desktop\\BLECA smartlabs\\bleca-finance\\src\\tests\\integration\\m15-period-close.test.ts', 'w') as f:
        f.write(new_content)
    print('Replacement successful')