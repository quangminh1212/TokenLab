from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time

def test_landing_page():
    options = webdriver.ChromeOptions()
    options.add_argument('--headless')  # Run in background
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
    
    errors = []
    
    try:
        print("Opening http://localhost:3737...")
        driver.get("http://localhost:3737")
        
        # Wait for page to load
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
        
        print("Page loaded. Checking elements...")
        
        # Check title
        try:
            title = driver.title
            print(f"Page title: {title}")
            if "XLab Token" not in title:
                errors.append(f"Title missing 'XLab Token': {title}")
        except Exception as e:
            errors.append(f"Failed to get title: {e}")
        
        # Check hero section
        try:
            hero = driver.find_element(By.CSS_SELECTOR, "h1")
            print(f"Hero text: {hero.text[:50]}...")
            if not hero.text:
                errors.append("Hero section empty")
        except Exception as e:
            errors.append(f"Hero section not found: {e}")
        
        # Check install command
        try:
            install_text = driver.find_element(By.CSS_SELECTOR, "code")
            print(f"Install command: {install_text.text}")
            if "xlab-token" not in install_text.text.lower():
                errors.append(f"Install command missing 'xlab-token': {install_text.text}")
        except Exception as e:
            errors.append(f"Install command not found: {e}")
        
        # Check GitHub link
        try:
            github_link = driver.find_element(By.CSS_SELECTOR, "a[href*='github.com']")
            print(f"GitHub link: {github_link.get_attribute('href')}")
            if "quangminh1212/XLab_Token" not in github_link.get_attribute('href'):
                errors.append(f"GitHub link incorrect: {github_link.get_attribute('href')}")
        except Exception as e:
            errors.append(f"GitHub link not found: {e}")
        
        # Check for console errors
        logs = driver.get_log('browser')
        if logs:
            print(f"\nBrowser console logs ({len(logs)} entries):")
            for log in logs:
                if log['level'] == 'SEVERE':
                    errors.append(f"Console error: {log['message']}")
                    print(f"  ERROR: {log['message']}")
                elif log['level'] == 'WARNING':
                    print(f"  WARNING: {log['message']}")
        
        # Take screenshot
        driver.save_screenshot("landing_screenshot.png")
        print("Screenshot saved to landing_screenshot.png")
        
    except Exception as e:
        errors.append(f"Test failed: {e}")
        print(f"Error: {e}")
    
    finally:
        driver.quit()
    
    # Report results
    print("\n" + "="*50)
    if errors:
        print(f"FOUND {len(errors)} ERRORS:")
        for i, error in enumerate(errors, 1):
            print(f"  {i}. {error}")
        return False
    else:
        print("ALL TESTS PASSED!")
        return True

if __name__ == "__main__":
    success = test_landing_page()
    exit(0 if success else 1)
