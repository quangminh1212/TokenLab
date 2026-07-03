from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
import time

def test_comprehensive():
    options = webdriver.ChromeOptions()
    options.add_argument('--headless')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--window-size=1920,1080')
    
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
    
    errors = []
    warnings = []
    
    try:
        print("="*60)
        print("COMPREHENSIVE FRONTEND TEST")
        print("="*60)
        
        # Test 1: Load landing page
        print("\n[TEST 1] Loading landing page...")
        driver.get("http://localhost:3737")
        WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.TAG_NAME, "body")))
        print("✓ Page loaded successfully")
        
        # Test 2: Check page title
        print("\n[TEST 2] Checking page title...")
        title = driver.title
        print(f"  Title: {title}")
        if "XLab Token" not in title:
            errors.append(f"Title missing 'XLab Token': {title}")
        else:
            print("✓ Title correct")
        
        # Test 3: Check Hero section
        print("\n[TEST 3] Checking Hero section...")
        try:
            hero = driver.find_element(By.CSS_SELECTOR, "h1")
            hero_text = hero.text
            print(f"  Hero: {hero_text[:50]}...")
            if not hero_text or "Kardashev" not in hero_text:
                errors.append("Hero section missing or incorrect")
            else:
                print("✓ Hero section correct")
        except Exception as e:
            errors.append(f"Hero section not found: {e}")
        
        # Test 4: Check install command
        print("\n[TEST 4] Checking install command...")
        try:
            install = driver.find_element(By.CSS_SELECTOR, "code")
            install_text = install.text
            print(f"  Command: {install_text}")
            if "xlab-token" not in install_text.lower():
                errors.append(f"Install command incorrect: {install_text}")
            else:
                print("✓ Install command correct")
        except Exception as e:
            errors.append(f"Install command not found: {e}")
        
        # Test 5: Check copy button
        print("\n[TEST 5] Checking copy button...")
        try:
            all_buttons = driver.find_elements(By.TAG_NAME, "button")
            print(f"  Found {len(all_buttons)} buttons")
            copy_found = False
            for i, btn in enumerate(all_buttons):
                btn_text = btn.text
                print(f"    Button {i}: '{btn_text}'")
                if btn_text and ("Copy" in btn_text or "Copied" in btn_text):
                    copy_found = True
                    print("✓ Copy button found")
                    break
            if not copy_found:
                errors.append("Copy button not found among all buttons")
        except Exception as e:
            errors.append(f"Copy button not found: {e}")
        
        # Test 6: Check GitHub star button
        print("\n[TEST 6] Checking GitHub star button...")
        try:
            star_btn = driver.find_element(By.CSS_SELECTOR, "a[href*='github.com']")
            star_href = star_btn.get_attribute('href')
            print(f"  GitHub link: {star_href}")
            if "quangminh1212/XLab_Token" not in star_href:
                errors.append(f"GitHub link incorrect: {star_href}")
            else:
                print("✓ GitHub link correct")
        except Exception as e:
            errors.append(f"GitHub link not found: {e}")
        
        # Test 7: Check Quickstart section
        print("\n[TEST 7] Checking Quickstart section...")
        try:
            quickstart_label = driver.find_element(By.XPATH, "//*[contains(text(), 'Quickstart')]")
            print("✓ Quickstart section found")
        except Exception as e:
            errors.append(f"Quickstart section not found: {e}")
        
        # Test 8: Check Description section
        print("\n[TEST 8] Checking Description section...")
        try:
            desc_text = driver.find_element(By.XPATH, "//*[contains(text(), 'high-performance CLI tool')]")
            print("✓ Description section found")
        except Exception as e:
            errors.append(f"Description section not found: {e}")
        
        # Test 9: Check Follow section
        print("\n[TEST 9] Checking Follow section...")
        try:
            follow_text = driver.find_element(By.XPATH, "//*[contains(text(), 'open-source work')]")
            print("✓ Follow section found")
        except Exception as e:
            errors.append(f"Follow section not found: {e}")
        
        # Test 10: Check Footer
        print("\n[TEST 10] Checking Footer...")
        try:
            footer = driver.find_element(By.XPATH, "//*[contains(text(), '©')]")
            print(f"  Footer: {footer.text[:50]}...")
            if "XLab Token" not in footer.text:
                errors.append(f"Footer missing 'XLab Token': {footer.text}")
            else:
                print("✓ Footer correct")
        except Exception as e:
            errors.append(f"Footer not found: {e}")
        
        # Test 11: Check Navigation
        print("\n[TEST 11] Checking Navigation...")
        try:
            nav = driver.find_element(By.CSS_SELECTOR, "nav, [role='navigation']")
            print("✓ Navigation found")
            
            # Check nav links
            nav_links = nav.find_elements(By.TAG_NAME, "a")
            print(f"  Found {len(nav_links)} nav links")
            for link in nav_links:
                href = link.get_attribute('href')
                if href:
                    print(f"    - {href}")
        except Exception as e:
            errors.append(f"Navigation not found: {e}")
        
        # Test 12: Check colors (CSS variables)
        print("\n[TEST 12] Checking CSS variables...")
        try:
            bg_color = driver.find_element(By.TAG_NAME, "body").value_of_css_property("background-color")
            print(f"  Body background: {bg_color}")
            if "rgb(255, 255, 255)" not in bg_color and "rgba(255, 255, 255" not in bg_color:
                warnings.append(f"Background color unexpected: {bg_color}")
            else:
                print("✓ Background color correct (white)")
        except Exception as e:
            errors.append(f"Failed to check background color: {e}")
        
        # Test 13: Check for console errors
        print("\n[TEST 13] Checking console errors...")
        logs = driver.get_log('browser')
        severe_count = 0
        warning_count = 0
        for log in logs:
            if log['level'] == 'SEVERE':
                severe_count += 1
                errors.append(f"Console error: {log['message']}")
                print(f"  ERROR: {log['message']}")
            elif log['level'] == 'WARNING':
                warning_count += 1
                warnings.append(f"Console warning: {log['message']}")
                print(f"  WARNING: {log['message']}")
        
        if severe_count == 0:
            print(f"✓ No console errors ({warning_count} warnings)")
        
        # Test 14: Responsive test - mobile
        print("\n[TEST 14] Testing responsive design (mobile)...")
        driver.set_window_size(375, 667)
        time.sleep(1)
        try:
            hero = driver.find_element(By.CSS_SELECTOR, "h1")
            print("✓ Mobile layout - Hero visible")
        except Exception as e:
            errors.append(f"Mobile layout failed: {e}")
        
        # Test 15: Responsive test - tablet
        print("\n[TEST 15] Testing responsive design (tablet)...")
        driver.set_window_size(768, 1024)
        time.sleep(1)
        try:
            hero = driver.find_element(By.CSS_SELECTOR, "h1")
            print("✓ Tablet layout - Hero visible")
        except Exception as e:
            errors.append(f"Tablet layout failed: {e}")
        
        # Reset to desktop
        driver.set_window_size(1920, 1080)
        time.sleep(1)
        
        # Test 16: Take screenshots
        print("\n[TEST 16] Taking screenshots...")
        driver.save_screenshot("screenshot_desktop.png")
        print("  ✓ Desktop screenshot saved")
        
        driver.set_window_size(375, 667)
        time.sleep(1)
        driver.save_screenshot("screenshot_mobile.png")
        print("  ✓ Mobile screenshot saved")
        
        driver.set_window_size(1920, 1080)
        time.sleep(1)
        
    except Exception as e:
        errors.append(f"Test failed with exception: {e}")
        print(f"\nException: {e}")
    
    finally:
        driver.quit()
    
    # Print summary
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    print(f"Errors: {len(errors)}")
    print(f"Warnings: {len(warnings)}")
    
    if errors:
        print("\nERRORS:")
        for i, error in enumerate(errors, 1):
            print(f"  {i}. {error}")
    
    if warnings:
        print("\nWARNINGS:")
        for i, warning in enumerate(warnings, 1):
            print(f"  {i}. {warning}")
    
    if not errors:
        print("\n✓ ALL TESTS PASSED!")
        return True
    else:
        print(f"\n✗ {len(errors)} TEST(S) FAILED")
        return False

if __name__ == "__main__":
    success = test_comprehensive()
    exit(0 if success else 1)
