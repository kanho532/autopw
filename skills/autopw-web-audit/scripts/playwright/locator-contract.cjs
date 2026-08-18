class AutoPWLocatorError extends Error {
  constructor(contract, count) {
    super(`AutoPW locator contract resolved to ${count} elements: ${JSON.stringify(contract)}`)
    this.name = 'AutoPWLocatorError'
    this.contract = contract
    this.count = count
  }
}

function locatorFromContract(page, contract) {
  switch (contract.strategy) {
    case 'TEST_ID': return page.getByTestId(contract.value)
    case 'ROLE': return page.getByRole(contract.value, { name: contract.name, exact: true })
    case 'LABEL': return page.getByLabel(contract.value, { exact: true })
    case 'PLACEHOLDER': return page.getByPlaceholder(contract.value, { exact: true })
    case 'TEXT': return page.getByText(contract.value, { exact: true })
    case 'CSS': return page.locator(contract.value)
    case 'RELATION': return page.locator(contract.parent).locator(contract.value)
    default: throw new Error(`Unsupported AutoPW locator strategy: ${contract.strategy}`)
  }
}

async function resolveUniqueLocator(page, contract) {
  const locator = locatorFromContract(page, contract)
  const count = await locator.count()
  if (count !== 1) throw new AutoPWLocatorError(contract, count)
  return locator
}

module.exports = { AutoPWLocatorError, locatorFromContract, resolveUniqueLocator }

